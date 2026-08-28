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
 * | `tool_call` (in_progress)       | `onToolActivity({ type: "start"})`|
 * | `tool_call` (completed/failed)  | `onToolActivity({ type: "end" })` |
 * | `tool_call_update` (→completed) | `onToolActivity({ type: "end" })` |
 * | `prompt()` resolves             | `onTurnEnd(++turnCount)`          |
 * | `PromptResponse.usage`          | `onAssistantUsage({...})`         |
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

// Hoisted once — reused across WebSocket frames instead of allocating per message.
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Callbacks that mirror a subset of `RunOptions` from `agent-runner.ts`. */
export interface AcpSessionCallbacks {
	/** Streaming text delta from the assistant. Receives the delta and the accumulated full text. */
	onTextDelta?: (delta: string, fullText: string) => void
	/** Tool activity start/end with the tool's display title. */
	onToolActivity?: (activity: { type: "start" | "end"; toolName: string }) => void
	/** Called at the end of each ACP turn with the cumulative turn count. */
	onTurnEnd?: (turnCount: number) => void
	/** Called with per-turn token usage when a `prompt()` resolves. */
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
	/** Abort signal — when aborted, calls `cancel()` on the remote session. */
	signal?: AbortSignal
	/** Working directory for the session (passed to newSession). */
	cwd?: string
	/**
	 * Inject a custom WebSocket constructor (for testing). When omitted, uses the `ws` package.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: ws types vary between Node and Bun
	WebSocketImpl?: any
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

		if (this._aborted) {
			await this.cancel()
			return
		}
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

		const response: PromptResponse = await this._withAbortRejection(
			this._withTimeout(
				this._connection.prompt({
					sessionId: this._sessionId,
					prompt: [{ type: "text", text }],
				}),
				// No upper bound on prompt duration — remote agents can run for
				// minutes on large repos. Use a generous default of 10 minutes.
				10 * 60_000,
				"prompt",
			),
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
			this._options.callbacks?.onAssistantUsage?.(usage)
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
		if (this._abortListener) {
			this._options.signal?.removeEventListener("abort", this._abortListener)
		}
		this._abortListener = undefined
		this._ws?.close()
		this._ws = null
		this._connection = null
	}

	/** Returns the session ID assigned by the remote agent, or null before initialize(). */
	get sessionId(): string | null {
		return this._sessionId
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

		const readable = new ReadableStream<Uint8Array>({
			start: (controller) => {
				let finished = false
				ws.on("message", (data: unknown) => {
					const text = typeof data === "string" ? data : textDecoder.decode(data as ArrayBuffer)
					const trimmed = text.trim()
					if (!trimmed?.startsWith("{")) return
					controller.enqueue(textEncoder.encode(`${text}\n`))
				})

				ws.on("close", () => {
					if (!finished) {
						finished = true
						controller.close()
					}
				})
				ws.on("error", (err: Error) => {
					if (!finished) {
						finished = true
						controller.error(err)
					}
				})
			},
		})

		const writable = new WritableStream<Uint8Array>({
			write: (chunk) => {
				if (ws.readyState !== ws.OPEN) {
					return Promise.reject(new Error("WebSocket is not open"))
				}
				return new Promise<void>((resolve, reject) => {
					ws.send(textDecoder.decode(chunk), (err) => {
						if (err) reject(err)
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
		if (!ws) return Promise.reject(new Error("WebSocket not created"))
		if (ws.readyState === ws.OPEN) return Promise.resolve()
		if (ws.readyState >= ws.CLOSING) return Promise.reject(new Error("WebSocket closed before connection established"))

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
				reject(err)
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
				reject(new Error(`${label} timed out after ${ms}ms`))
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
				this._dispatchToolActivity(cb, update.status, update.title)
				break
			}
			case "tool_call_update": {
				this._dispatchToolActivity(cb, update.status, update.title ?? "tool")
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
		title: string,
	): void {
		if (status === "in_progress") {
			cb.onToolActivity?.({ type: "start", toolName: title })
		} else if (status === "completed" || status === "failed") {
			cb.onToolActivity?.({ type: "end", toolName: title })
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
