/**
 * AcpSessionClient — a client-side ACP connection over WebSocket.
 *
 * Connects to the sandbox worker's WebSocket endpoint (`wss://.../session/{name}/connect`),
 * bridges WebSocket ↔ web streams, wraps with `ndJsonStream()` from the ACP SDK, and drives
 * a `ClientSideConnection` that handles all JSON-RPC 2.0 framing, request/response correlation,
 * and notification dispatch.
 *
 * Translates ACP `sessionUpdate` notifications into typed callbacks that mirror the
 * `RunOptions` callback contract used by `runAgent()`:
 *
 * | ACP `sessionUpdate`             | Callback                          |
 * | ------------------------------- | --------------------------------- |
 * | `agent_message_chunk`           | `onTextDelta(delta, fullText)`    |
 * | `tool_call` (in_progress)       | `onToolActivity({ status: "in_progress" })`|
 * | `tool_call` (completed/failed)  | `onToolActivity({ status: "completed"/"failed" })` |
 * | `tool_call_update` (→completed) | `onToolActivity({ status: "completed"/"failed" })` |
 * | `prompt()` resolves             | `onTurnEnd(++turnCount)`          |
 * | `usage_update`                  | `onContextUsage(used, size)`      |
 * | `usage_update` (+ `_meta` totals)| `onAssistantUsage(delta)`         |
 * | `PromptResponse.usage`          | `onAssistantUsage({remainder})`   |
 *
 * Designed to be plugged into a `runRemoteAgent()` function that mirrors `runAgent()`'s
 * callback contract but sources events from this client instead of a local `AgentSession`.
 */

import {
	type Client,
	ClientSideConnection,
	type NewSessionResponse,
	ndJsonStream,
	PROTOCOL_VERSION,
	type PromptResponse,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
	type ToolCallStatus,
} from "@agentclientprotocol/sdk"
import WebSocket from "ws"
import type { LifetimeUsage } from "../../extensions/agents/manager/usage.js"
import type { WorkspaceCredentials } from "../cloud/types.js"
import { ACP_REATTACH_MID_TURN_META_KEY, parseToolCallId, readLifetimeUsageMeta } from "./acp-protocol.js"

// Hoisted once — reused across WebSocket frames instead of allocating per message.
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Thrown when the WebSocket transport fails (close, error, timeout) during
 * `initialize()` or `prompt()`. Distinct from ACP protocol errors (which are
 * legitimate agent responses) and abort signals (which are user-initiated).
 *
 * Callers can use `instanceof RemoteConnectionError` to classify a failure
 * as transport-level — suitable for reconnect/retry logic.
 */
export class RemoteConnectionError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = "RemoteConnectionError"
	}
}

/** Callbacks that mirror a subset of `RunOptions` from `agent-runner.ts`. */
export interface AcpSessionCallbacks {
	/** Streaming text delta from the assistant. Receives the delta and the accumulated full text. */
	onTextDelta?: (delta: string, fullText: string) => void
	/** Tool activity start/end with the tool's display title and ACP status. */
	onToolActivity?: (activity: {
		toolName: string
		toolCallId?: string
		status: ToolCallStatus
		title?: string
		/** Tool arguments (ACP rawInput) — present on in_progress notifications. */
		rawInput?: unknown
	}) => void
	/** Called at the end of each ACP turn with the cumulative turn count. */
	onTurnEnd?: (turnCount: number) => void
	/** Called on each usage_update with the context-window state (used/size). */
	onContextUsage?: (used: number, size: number) => void
	/** Called with per-turn token usage when a `prompt()` resolves, and — when
	 *  the server attaches cumulative lifetime totals to usage_update `_meta` —
	 *  incrementally during the turn as deltas. */
	onAssistantUsage?: (usage: LifetimeUsage) => void
	/** Receives every raw SessionNotification before dispatch to typed callbacks. */
	onRawNotification?: (params: SessionNotification) => void
}

export interface AcpSessionClientOptions {
	/** The session name on the worker (used in the WebSocket path). */
	sessionName: string
	/** Workspace credentials containing the WebSocket URL and auth token. */
	credentials: WorkspaceCredentials
	/** Event callbacks translated from ACP session updates. */
	callbacks?: AcpSessionCallbacks
	/** Opt in to capturing the session/load replay (exposed via `loadReplay`)
	 *  for protocol-level result recovery. Leave unset on live/reattached
	 *  clients — only a dedicated recovery client needs the copy. */
	captureLoadReplay?: boolean
	/** Called when a JSON-RPC response arrives whose id matches no request sent
	 *  on this connection — the ORIGINAL connection's prompt response after a
	 *  mid-turn takeover, i.e. the remote turn's end. The caller should treat
	 *  it as the turn-end signal and recover the result immediately (the remote
	 *  child may be reaped shortly after the session goes idle). */
	onForeignResponse?: (response: unknown) => void
	/** Abort signal — when aborted, calls `cancel()` on the remote session. */
	signal?: AbortSignal
	/** Working directory for the session (passed to newSession). */
	cwd?: string
	/**
	 * Existing ACP session id to REATTACH to via `session/load` instead of
	 * creating a fresh session with `session/new`. Used on reconnect: the
	 * remote session kept running server-side, so re-creating it would
	 * restart the task from scratch (and duplicate side effects).
	 */
	sessionId?: string
	/**
	 * Inject a custom WebSocket constructor (for testing). When omitted, uses the `ws` package.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: ws types vary between Node and Bun
	WebSocketImpl?: any
}

/** Parses a single JSON-RPC frame line; undefined for non-JSON or malformed. */
function parseJsonRpcFrame(text: string): Record<string, unknown> | undefined {
	if (!text.startsWith("{")) return undefined
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>
		return typeof parsed === "object" && parsed !== null ? parsed : undefined
	} catch {
		return undefined
	}
}

/** Result of a single `prompt()` call. */
export interface AcpPromptResult {
	stopReason: PromptResponse["stopReason"]
	usage?: LifetimeUsage
}

// ---------------------------------------------------------------------------
// AcpSessionClient
// ---------------------------------------------------------------------------

export class AcpSessionClient {
	private readonly _options: AcpSessionClientOptions
	private _ws: WebSocket | null = null
	private _connection: ClientSideConnection | null = null
	private _sessionId: string | null = null
	private _turnCount = 0
	private _accumulatedText = ""
	private _closed = false
	private _aborted = false
	private _abortListener: (() => void) | undefined
	/** Reject function for the currently-pending initialize()/prompt() promise. */
	private _pendingReject: ((err: Error) => void) | undefined
	/** Maps toolCallId → title so tool_call_update events with null title
	 *  can resolve to the original tool name from the initial tool_call. */
	private _toolCallTitles = new Map<string, string>()
	/** True while a session/load request is in flight — the server replays
	 * the conversation history during load, and those notifications must be
	 * suppressed (they duplicate events received before the disconnect). */
	private _loading = false
	/** Captured session/load replay — the history the server streamed while a
	 *  load was in flight. Exposed via `loadReplay` for protocol-level result
	 *  recovery when the transcript file cannot be fetched. */
	private _loadReplay: SessionNotification[] = []
	/** Last cumulative lifetime usage totals seen via usage_update `_meta` —
	 *  the baseline for delta computation. Reset per prompt() so consecutive
	 *  prompts on one session don't suppress each other's usage. */
	private _lastLifetimeUsage: LifetimeUsage | undefined
	/** WS ping interval — detects broken connections within ~30s instead of minutes. */
	private _pingTimer: ReturnType<typeof setInterval> | undefined
	/** Tracks whether we've received any data since the last ping. The WS 'pong'
	 *  handler sets this to true, proving the connection is alive. */
	private _awaitingPong = false

	constructor(options: AcpSessionClientOptions) {
		this._options = options
	}

	/**
	 * Connects to the worker WebSocket, initializes the ACP connection,
	 * and creates a new session.
	 *
	 * Must be called before `prompt()` / `cancel()`.
	 */
	async initialize(): Promise<void> {
		this._ws = this._connectWebSocket()
		const stream = this._bridgeStreams()

		const client: Client = {
			sessionUpdate: (params: SessionNotification) => this._handleSessionUpdate(params),
			requestPermission: (params) => this._handleRequestPermission(params),
			extNotification: () => Promise.resolve(),
		}

		this._connection = new ClientSideConnection((_) => client, stream)

		// Register abort listener early so we catch aborts during initialize/newSession
		// (before _sessionId is assigned). The listener sets _aborted so we can cancel
		// after _sessionId is set.
		if (this._options.signal) {
			if (this._options.signal.aborted) {
				this._aborted = true
			} else {
				this._abortListener = () => {
					this._aborted = true
					// Reject any pending initialize()/prompt() promise so callers
					// don't hang waiting for a response that will never arrive.
					this._rejectPending(new Error("Aborted"))
					this.cancel().catch(() => {})
				}
				this._options.signal.addEventListener("abort", this._abortListener)
			}
		}

		await this._waitForOpen()

		await this._withAbortRejection(
			this._withTimeout(
				this._connection.initialize({
					protocolVersion: PROTOCOL_VERSION,
				}),
				30_000,
				"initialize",
			),
		)

		const resumeSessionId = this._options.sessionId
		if (resumeSessionId) {
			// Reattach path: load the EXISTING session (the remote agent kept it
			// alive server-side) instead of creating a fresh one. The server
			// replays the conversation history as session/update notifications
			// before responding — the local transcript already received those
			// events before the disconnect, so dispatch is suppressed while the
			// load is in flight (_loading).
			this._sessionId = resumeSessionId
			this._loadReplay = []
			this._loading = true
			try {
				await this._withAbortRejection(
					this._withTimeout(
						this._connection.loadSession({
							sessionId: resumeSessionId,
							cwd: this._options.cwd ?? "/home/sandbox",
							mcpServers: [],
							// Opt in to mid-turn attach: this client takes over a
							// session whose owning connection died. Other clients
							// keep the strict "cancel it first" guard.
							_meta: { [ACP_REATTACH_MID_TURN_META_KEY]: true },
						}),
						30_000,
						"loadSession",
					),
				)
			} finally {
				this._loading = false
			}
		} else {
			const newSessionResponse: NewSessionResponse = await this._withAbortRejection(
				this._withTimeout(
					this._connection.newSession({
						cwd: this._options.cwd ?? "/home/sandbox",
						mcpServers: [],
					}),
					30_000,
					"newSession",
				),
			)
			this._sessionId = newSessionResponse.sessionId
		}

		// Set permission mode to yolo after session creation. The ACP server's
		// initial mode resolution doesn't read the --yolo CLI flag (it reads
		// env vars and config), so we explicitly set it here via the ACP
		// setSessionConfigOption method. This is the same mechanism used by
		// the ACP config option dropdown.
		await this._withAbortRejection(
			this._withTimeout(
				this._connection.setSessionConfigOption({
					sessionId: this._sessionId,
					configId: "permissions-mode",
					value: "yolo",
				}),
				30_000,
				"setSessionConfigOption",
			),
		)

		if (this._aborted) {
			await this.cancel()
			return
		}

		// Start WS ping keepalive — detects broken connections (Wi-Fi drop,
		// laptop sleep) within ~30s instead of waiting minutes for TCP to timeout.
		this._startPingKeepalive()
	}

	/**
	 * Sends a prompt to the remote agent and resolves when the turn completes.
	 *
	 * Returns `{ stopReason, usage? }`. While waiting, ACP `sessionUpdate`
	 * notifications flow through the configured callbacks.
	 */
	async prompt(text: string): Promise<AcpPromptResult> {
		if (!this._connection || !this._sessionId) {
			throw new Error("AcpSessionClient not initialized — call initialize() first")
		}

		this._accumulatedText = ""
		this._lastLifetimeUsage = undefined

		// No upper bound on prompt duration — remote agents can run for tens of
		// minutes on large repos. A wall-clock timeout cannot distinguish a slow
		// turn from a dead connection (and wrongly closes a healthy WS), so
		// transport failure detection is left to the ping keepalive instead.
		const response: PromptResponse = await this._withAbortRejection(
			this._connection.prompt({
				sessionId: this._sessionId,
				prompt: [{ type: "text", text }],
			}),
		)

		this._turnCount++
		this._options.callbacks?.onTurnEnd?.(this._turnCount)

		let usage: LifetimeUsage | undefined
		if (response.usage) {
			usage = {
				input: response.usage.inputTokens ?? 0,
				output: response.usage.outputTokens ?? 0,
				cacheRead: response.usage.cachedReadTokens ?? 0,
				cacheWrite: response.usage.cachedWriteTokens ?? 0,
			}
			if (this._lastLifetimeUsage) {
				// Mid-run usage_update notifications already reported the turn's
				// consumption via _meta deltas — emit only the remainder so the
				// turn's totals aren't double-counted.
				this._emitLifetimeDelta(usage)
			} else {
				this._options.callbacks?.onAssistantUsage?.(usage)
			}
		}

		return {
			stopReason: response.stopReason,
			usage,
		}
	}

	/** Cancels the in-progress prompt turn (if any). Sends `session/cancel`. */
	async cancel(): Promise<void> {
		if (!this._connection || !this._sessionId) return
		await this._connection.cancel({ sessionId: this._sessionId })
	}

	/** Closes the WebSocket and frees resources. Safe to call multiple times. */
	close(): void {
		if (this._closed) return
		this._closed = true
		this._stopPingKeepalive()
		if (this._abortListener) {
			this._options.signal?.removeEventListener("abort", this._abortListener)
		}
		this._abortListener = undefined
		this._ws?.close()
		this._ws = null
		this._connection = null
	}

	/**
	 * Forcefully terminates the WebSocket — used by the poll loop when it
	 * detects that the connection is broken (e.g. getSession succeeds but
	 * returns clientConnected=false, or getSession HTTP fails entirely).
	 * Causes the pending prompt() to reject with RemoteConnectionError so
	 * the recovery state machine can take over.
	 */
	forceDisconnect(reason: string): void {
		this._stopPingKeepalive()
		this._rejectPending(new RemoteConnectionError(reason))
		this._ws?.close()
	}

	/** Returns the session ID assigned by the remote agent, or null before initialize(). */
	get sessionId(): string | null {
		return this._sessionId
	}

	/** The session/load replay captured during the last initialize() (empty for
	 *  new sessions and before initialize). Read-only view. */
	get loadReplay(): readonly SessionNotification[] {
		return this._loadReplay
	}

	// -- internal: WebSocket creation ---------------------------------------

	/**
	 * Creates a WebSocket to `wss://host/session/{name}/connect` with Bearer auth.
	 */
	private _connectWebSocket(): WebSocket {
		const base = this._options.credentials.wsUrl.replace(/\/+$/, "")
		const wsUrl = `${base}/session/${encodeURIComponent(this._options.sessionName)}/connect`
		const WS = this._options.WebSocketImpl ?? WebSocket

		const ws = new WS(wsUrl, {
			headers: {
				Authorization: `Bearer ${this._options.credentials.connectToken}`,
			},
		})
		ws.binaryType = "arraybuffer"
		return ws
	}

	// -- internal: WS ping keepalive ---------------------------------------

	/**
	 * Starts a ping keepalive that sends WS ping frames every 15s. If no
	 * pong response is received within 30s, the connection is considered
	 * broken and the pending prompt() is rejected with RemoteConnectionError.
	 *
	 * This is critical for detecting Wi-Fi drops and laptop sleep — without
	 * pings, TCP can take minutes or hours to notice a dead connection.
	 */
	private _startPingKeepalive(): void {
		const PING_INTERVAL_MS = 15_000
		this._awaitingPong = false
		this._pingTimer = setInterval(() => {
			const ws = this._ws
			if (!ws || ws.readyState !== ws.OPEN) return

			if (this._awaitingPong) {
				// Previous ping was never answered — connection is dead.
				this._stopPingKeepalive()
				this._rejectPending(new RemoteConnectionError("WebSocket ping timeout — connection lost"))
				ws.close()
				return
			}

			this._awaitingPong = true
			ws.ping()
		}, PING_INTERVAL_MS)
	}

	private _stopPingKeepalive(): void {
		if (this._pingTimer) {
			clearInterval(this._pingTimer)
			this._pingTimer = undefined
		}
	}

	// -- internal: WebSocket ↔ web stream bridge ---------------------------

	/**
	 * Bridges WebSocket events to Node.js web streams, then wraps with `ndJsonStream()`.
	 *
	 * The worker's RPC handler sends each stdout line as a separate text WebSocket frame
	 * WITHOUT a trailing newline — we append one so `ndJsonStream` can delimit messages.
	 * Non-JSON lines (pnpm install output, etc.) are filtered out.
	 */
	private _bridgeStreams() {
		const ws = this._ws
		if (!ws) throw new Error("WebSocket not created — call initialize() first")

		/** Request ids sent on THIS connection — used to spot foreign responses:
		 *  the ORIGINAL connection's prompt response arriving after a mid-turn
		 *  takeover, which signals the remote turn's end. */
		const sentIds = new Set<number | string>()

		const readable = new ReadableStream<Uint8Array>({
			start: (controller) => {
				let finished = false
				ws.on("message", (data: unknown) => {
					const text = typeof data === "string" ? data : textDecoder.decode(data as ArrayBuffer)
					// Foreign-response detection: a RESPONSE frame whose id matches no
					// request sent on this connection is the previous connection's
					// prompt response after a takeover — the remote turn's end. When a
					// callback is set, foreign frames are consumed here (the SDK would
					// only log "Got response to unknown request" for them); otherwise
					// they pass through untouched, preserving the SDK's default behavior.
					const kept: string[] = []
					for (const line of text.split("\n")) {
						const trimmedLine = line.trim()
						if (!trimmedLine.startsWith("{")) continue // non-JSON frames filtered as before
						const frame = parseJsonRpcFrame(trimmedLine)
						if (
							frame &&
							frame.method === undefined &&
							("result" in frame || "error" in frame) &&
							(typeof frame.id === "number" || typeof frame.id === "string") &&
							!sentIds.has(frame.id)
						) {
							this._options.onForeignResponse?.(frame)
							if (this._options.onForeignResponse) continue
						}
						kept.push(line)
					}
					if (kept.length > 0) controller.enqueue(textEncoder.encode(`${kept.join("\n")}\n`))
				})

				ws.on("pong", () => {
					this._awaitingPong = false
				})

				ws.on("close", () => {
					if (!finished) {
						finished = true
						controller.error(new RemoteConnectionError("WebSocket closed"))
					}
				})
				ws.on("error", (err: Error) => {
					if (!finished) {
						finished = true
						controller.error(new RemoteConnectionError(`WebSocket error: ${err.message}`, { cause: err }))
					}
				})
			},
		})

		const writable = new WritableStream<Uint8Array>({
			write: (chunk) => {
				// Record request ids for foreign-response detection (see readable).
				for (const line of textDecoder.decode(chunk).split("\n")) {
					const frame = parseJsonRpcFrame(line.trim())
					if (!frame || typeof frame.method !== "string") continue
					const id = frame.id
					if (typeof id === "number" || typeof id === "string") sentIds.add(id)
				}
				if (ws.readyState !== ws.OPEN) {
					return Promise.reject(new RemoteConnectionError("WebSocket is not open"))
				}
				return new Promise<void>((resolve, reject) => {
					ws.send(textDecoder.decode(chunk), (err) => {
						if (err) reject(new RemoteConnectionError("WebSocket send failed", { cause: err }))
						else resolve()
					})
				})
			},
		})

		return ndJsonStream(writable, readable)
	}

	/** Returns a promise that resolves when the WebSocket emits "open". */
	private _waitForOpen(): Promise<void> {
		const ws = this._ws
		if (!ws) return Promise.reject(new RemoteConnectionError("WebSocket not created"))
		if (ws.readyState === ws.OPEN) return Promise.resolve()
		if (ws.readyState >= ws.CLOSING)
			return Promise.reject(new RemoteConnectionError("WebSocket closed before connection established"))

		return new Promise<void>((resolve, reject) => {
			const cleanup = (): void => {
				ws.off("open", onOpen)
				ws.off("error", onError)
			}
			const onOpen = (): void => {
				cleanup()
				resolve()
			}
			const onError = (err: Error): void => {
				cleanup()
				reject(new RemoteConnectionError("WebSocket failed to open", { cause: err }))
			}
			ws.on("open", onOpen)
			ws.on("error", onError)
		})
	}

	/** Races a promise against a timeout. On timeout, closes the WebSocket and rejects. */
	private _withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout>
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				this._ws?.close()
				reject(new RemoteConnectionError(`${label} timed out after ${ms}ms`))
			}, ms)
		})
		return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
	}

	/**
	 * Wraps a promise so that an external abort signal rejects it immediately.
	 * The abort listener (set in `initialize()`) calls `_rejectPending()` which
	 * rejects the promise captured here, preventing `initialize()`/`prompt()`
	 * from hanging indefinitely if the signal fires mid-flight.
	 */
	private _withAbortRejection<T>(promise: Promise<T>): Promise<T> {
		if (this._aborted) {
			// Swallow the underlying promise so it doesn't become an unhandled rejection.
			promise.catch(() => {})
			return Promise.reject(new Error("Aborted"))
		}
		return new Promise<T>((resolve, reject) => {
			this._pendingReject = reject
			promise.then(
				(val) => {
					this._pendingReject = undefined
					resolve(val)
				},
				(err) => {
					this._pendingReject = undefined
					reject(err)
				},
			)
		})
	}

	/** Rejects the pending initialize()/prompt() promise (if any) with the given error. */
	private _rejectPending(err: Error): void {
		if (this._pendingReject) {
			const fn = this._pendingReject
			this._pendingReject = undefined
			fn(err)
		}
	}

	// -- internal: ACP notification handling --------------------------------

	private _handleSessionUpdate(params: SessionNotification): Promise<void> {
		// session/load replays the entire history — to the local transcript
		// these are duplicates of events received before the disconnect. The
		// captured copy is exposed via `loadReplay` for protocol-level result
		// recovery when the transcript file cannot be fetched.
		if (this._loading) {
			if (this._options.captureLoadReplay) this._loadReplay.push(params)
			return Promise.resolve()
		}
		this._options.callbacks?.onRawNotification?.(params)
		const update = params.update
		const cb = this._options.callbacks
		if (!cb) return Promise.resolve()

		switch (update.sessionUpdate) {
			case "agent_message_chunk": {
				if (update.content.type === "text") {
					const delta = update.content.text
					this._accumulatedText += delta
					cb.onTextDelta?.(delta, this._accumulatedText)
				}
				break
			}
			case "tool_call": {
				if (update.title) {
					this._toolCallTitles.set(update.toolCallId, update.title)
				}
				this._dispatchToolActivity(cb, update.status, update.toolCallId, update.title, update.rawInput)
				break
			}
			case "tool_call_update": {
				// Refresh the title cache when the update carries one: the in_progress
				// update has the full-args title, superseding the partial title that
				// streamed in on the pending tool_call. Completed/failed updates carry
				// no title at all (server only sends status/content/rawOutput), so
				// they resolve through this cache — and must get the LATEST title.
				if (update.title) {
					this._toolCallTitles.set(update.toolCallId, update.title)
				}
				const title = update.title ?? this._toolCallTitles.get(update.toolCallId)
				this._dispatchToolActivity(cb, update.status, update.toolCallId, title, update.rawInput)
				break
			}
			case "usage_update": {
				cb.onContextUsage?.(update.used, update.size)
				// Servers that fold lifetime totals into _meta let clients show
				// live token counts during long remote runs. Cumulative totals
				// make the delta idempotent across session/load replays.
				const totals = readLifetimeUsageMeta(params._meta)
				if (totals) this._emitLifetimeDelta(totals)
				break
			}
			default:
				break
		}

		return Promise.resolve()
	}

	private _dispatchToolActivity(
		cb: AcpSessionCallbacks,
		status: ToolCallStatus | null | undefined,
		toolCallId: string,
		title: string | undefined,
		rawInput?: unknown,
	): void {
		// pending = model is still streaming the args — nothing is executing yet.
		if (!status || status === "pending") return
		// Extract the actual tool name from the ACP toolCallId.
		// The format is `kt.<toolName>.<counter>` (e.g. kt.bash.1, kt.web_fetch.2).
		// Fall back to the ACP title, then the raw id.
		const toolName = parseToolCallId(toolCallId)?.toolName ?? title ?? toolCallId
		// Attach rawInput only when the notification carries it — keeps the
		// payload shape stable for notifications without args.
		cb.onToolActivity?.({
			toolName,
			toolCallId,
			status,
			title,
			...(rawInput != null ? { rawInput } : {}),
		})
		// completed/failed clears the title cache entry.
		if (status !== "in_progress") this._toolCallTitles.delete(toolCallId)
	}

	/** Reports the increase of cumulative lifetime usage totals over the last
	 *  seen snapshot as an onAssistantUsage delta. All-zero deltas are swallowed
	 *  (idempotent replays); the snapshot is recorded even when swallowed so a
	 *  later decrease (fresh turn) can't fabricate negative counts. */
	private _emitLifetimeDelta(totals: LifetimeUsage): void {
		const last = this._lastLifetimeUsage
		const delta: LifetimeUsage = {
			input: Math.max(0, totals.input - (last?.input ?? 0)),
			output: Math.max(0, totals.output - (last?.output ?? 0)),
			cacheRead: Math.max(0, totals.cacheRead - (last?.cacheRead ?? 0)),
			cacheWrite: Math.max(0, totals.cacheWrite - (last?.cacheWrite ?? 0)),
		}
		this._lastLifetimeUsage = totals
		if (delta.input > 0 || delta.output > 0 || delta.cacheRead > 0 || delta.cacheWrite > 0) {
			this._options.callbacks?.onAssistantUsage?.(delta)
		}
	}

	/**
	 * Rejects all permission requests from the remote worker.
	 *
	 * The remote session is created with `yolo: true`, so this should never fire.
	 * If it does, the remote worker is misconfigured or compromised — auto-approving
	 * would grant unauthorised access. We log a warning and cancel the request so
	 * the agent does not proceed with an unauthorised tool call. Future versions
	 * could forward permission requests to the local UI via a callback.
	 */
	private _handleRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		console.warn(
			`[acp-client] unexpected permission request from remote agent (toolCall: ${params.toolCall.title ?? "unknown"}) — rejecting despite yolo session`,
		)
		return Promise.resolve({
			outcome: {
				outcome: "cancelled",
			},
		})
	}
}

/**
 * Extracts the final assistant message text from a session/load replay.
 *
 * The replay carries no timestamps, so this walks the notification stream and
 * accumulates agent_message_chunk text, resetting at every user message and
 * tool call — whatever remains when the stream ends is the final assistant
 * message (the answer). Thought chunks interleave inside a message without
 * ending it, so they neither reset nor contribute.
 */
export function extractFinalAssistantText(notifications: readonly SessionNotification[]): string {
	let text = ""
	for (const params of notifications) {
		const update = params.update
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (update.content.type === "text") text += update.content.text
				break
			case "user_message_chunk":
			case "tool_call":
			case "tool_call_update":
				text = ""
				break
			default:
				break
		}
	}
	return text
}
