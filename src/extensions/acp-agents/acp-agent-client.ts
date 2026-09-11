/**
 * StdioAcpClient — client-side ACP connection over a local child process's stdio.
 *
 * Spawns an ACP-speaking agent (e.g. `gemini --acp`), bridges the child's
 * stdin/stdout to web streams, wraps them with `ndJsonStream()` from the ACP
 * SDK, and drives a `ClientSideConnection` that handles JSON-RPC framing,
 * request/response correlation, and notification dispatch.
 *
 * Translates ACP `sessionUpdate` notifications into the same
 * `AcpSessionCallbacks` contract the sandbox remote runner uses
 * (`src/sandbox/worker/acp-client.ts`), so runners can treat both clients
 * uniformly.
 *
 * Resilience posture (stolen from pi-acp-agents + the sandbox client):
 * - per-operation timeouts (initialize 30s, newSession 60s, prompt 15 min)
 * - abort signal rejects pending operations and cancels the remote turn
 * - close() escalates SIGTERM → SIGKILL
 * - requestPermission denies by default; `permissions: "allow"` is an
 *   explicit opt-in for trusted local agents (auto-approving would grant
 *   unauthorised access, matching the sandbox client's security posture)
 */

import { type ChildProcess, spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import {
	type Client,
	ClientSideConnection,
	ndJsonStream,
	PROTOCOL_VERSION,
	type PromptResponse,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
	type ToolCallStatus,
} from "@agentclientprotocol/sdk"
import type { AcpPromptResult, AcpSessionCallbacks } from "../../sandbox/worker/acp-client.js"

const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000
const DEFAULT_NEW_SESSION_TIMEOUT_MS = 60_000
const DEFAULT_PROMPT_TIMEOUT_MS = 15 * 60_000
const CLOSE_GRACE_MS = 5_000
const STDERR_TAIL_BYTES = 2048

/** MCP server entry passed to newSession — the external agent spawns and connects to it.
 *  `name` is required by the ACP protocol (real agents validate it), and
 *  `env` defaults to [] on the wire — the stdio McpServer marks it required. */
export interface AcpMcpServer {
	name: string
	command: string
	args?: string[]
	env?: Array<{ name: string; value: string }>
}

export interface StdioAcpClientOptions {
	command: string
	args?: string[]
	/** Extra environment variables merged over the host environment. */
	env?: Record<string, string>
	/** Working directory for the child process. */
	cwd?: string
	/** Event callbacks translated from ACP session updates. */
	callbacks?: AcpSessionCallbacks
	/** Abort signal — when aborted, rejects pending operations and cancels the turn. */
	signal?: AbortSignal
	/** MCP servers the external agent should load (e.g. the host comms shim). */
	mcpServers?: AcpMcpServer[]
	initializeTimeoutMs?: number
	newSessionTimeoutMs?: number
	promptTimeoutMs?: number
	/** requestPermission posture: "deny" (default) or "allow" for trusted local agents. */
	permissions?: "deny" | "allow"
}

export class StdioAcpClient {
	private readonly _options: StdioAcpClientOptions
	private _child: ChildProcess | null = null
	private _connection: ClientSideConnection | null = null
	private _sessionId: string | null = null
	private _turnCount = 0
	private _accumulatedText = ""
	private _closed = false
	private _aborted = false
	private _abortListener: (() => void) | undefined
	/** Reject function for the currently-pending initialize()/prompt() promise. */
	private _pendingReject: ((err: Error) => void) | undefined
	/** Rolling tail of the child's stderr, surfaced on failures. */
	private _stderrTail = ""

	constructor(options: StdioAcpClientOptions) {
		this._options = options
	}

	/** Session ID assigned by the remote agent, or null before initialize(). */
	get sessionId(): string | null {
		return this._sessionId
	}

	/**
	 * Spawns the child process, initializes the ACP connection, and creates
	 * a new session. Must be called before prompt() / cancel().
	 */
	async initialize(): Promise<void> {
		if (this._closed) throw new Error("StdioAcpClient already closed")
		this._child = this._spawnChild()

		const stream = ndJsonStream(
			Writable.toWeb(this._child.stdin as Writable) as WritableStream<Uint8Array>,
			Readable.toWeb(this._child.stdout as Readable) as ReadableStream<Uint8Array>,
		)

		const client: Client = {
			sessionUpdate: (params: SessionNotification) => this._handleSessionUpdate(params),
			requestPermission: (params: RequestPermissionRequest) => this._handleRequestPermission(params),
			extNotification: () => Promise.resolve(),
		}

		this._connection = new ClientSideConnection((_) => client, stream)

		// Abort listener early: catch aborts during initialize/newSession and
		// reject pending promises so callers don't hang.
		if (this._options.signal) {
			if (this._options.signal.aborted) {
				this._aborted = true
			} else {
				this._abortListener = () => {
					this._aborted = true
					this._rejectPending(new Error("Aborted"))
					this.cancel().catch(() => {})
				}
				this._options.signal.addEventListener("abort", this._abortListener)
			}
		}

		this._child.on("exit", (code, signal) => {
			// Reject a pending prompt with diagnostics when the agent dies mid-turn.
			if (code !== null || signal) {
				const tail = this._stderrTail ? `\nstderr tail: ${this._stderrTail}` : ""
				this._rejectPending(new Error(`ACP agent process exited (code=${code} signal=${signal}).${tail}`))
			}
		})

		await this._withAbortRejection(
			this._withTimeout(
				this._connection.initialize({ protocolVersion: PROTOCOL_VERSION }),
				this._options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
				"initialize",
			),
		)

		const newSessionResponse = await this._withAbortRejection(
			this._withTimeout(
				this._connection.newSession({
					cwd: this._options.cwd ?? process.cwd(),
					// env defaults to [] on the wire — the ACP stdio McpServer marks
					// it required and real agents (kimchi --mode acp) reject its absence.
					mcpServers: (this._options.mcpServers ?? []).map((s) => ({ ...s, env: s.env ?? [] })),
				}),
				this._options.newSessionTimeoutMs ?? DEFAULT_NEW_SESSION_TIMEOUT_MS,
				"newSession",
			),
		)
		this._sessionId = newSessionResponse.sessionId

		if (this._aborted) {
			await this.cancel()
		}
	}

	/**
	 * Sends a prompt to the external agent and resolves when the turn
	 * completes. While waiting, ACP `sessionUpdate` notifications flow
	 * through the configured callbacks.
	 */
	async prompt(text: string): Promise<AcpPromptResult> {
		if (!this._connection || !this._sessionId) {
			throw new Error("StdioAcpClient not initialized — call initialize() first")
		}

		this._accumulatedText = ""

		const response: PromptResponse = await this._withAbortRejection(
			this._withTimeout(
				this._connection.prompt({
					sessionId: this._sessionId,
					prompt: [{ type: "text", text }],
				}),
				this._options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
				"prompt",
			),
		)

		this._turnCount++
		this._options.callbacks?.onTurnEnd?.(this._turnCount)

		let usage: AcpPromptResult["usage"]
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

	/** Cancels the in-progress prompt turn (if any). Sends session/cancel. */
	async cancel(): Promise<void> {
		if (!this._connection || !this._sessionId) return
		await this._connection.cancel({ sessionId: this._sessionId })
	}

	/**
	 * Selects the model for the current session via the experimental
	 * `session/set_model` request. No-op before initialize(); servers
	 * without model support reject (callers decide whether that is fatal).
	 */
	async setModel(model: string): Promise<void> {
		if (!this._connection || !this._sessionId) return
		await this._connection.unstable_setSessionModel({ sessionId: this._sessionId, modelId: model })
	}

	/** Kills the child process with SIGTERM→SIGKILL escalation and frees resources. */
	close(): void {
		if (this._closed) return
		this._closed = true
		if (this._abortListener) {
			this._options.signal?.removeEventListener("abort", this._abortListener)
		}
		this._abortListener = undefined
		const child = this._child
		if (child && child.exitCode === null && !child.killed) {
			child.kill("SIGTERM")
			const killTimer = setTimeout(() => {
				if (child.exitCode === null && !child.killed) child.kill("SIGKILL")
			}, CLOSE_GRACE_MS)
			killTimer.unref?.()
		}
		this._child = null
		this._connection = null
	}

	// -- internal: child spawn -----------------------------------------------

	private _spawnChild(): ChildProcess {
		const child = spawn(this._options.command, this._options.args ?? [], {
			cwd: this._options.cwd,
			env: { ...process.env, ...this._options.env },
			stdio: ["pipe", "pipe", "pipe"],
		})
		// Capture a rolling stderr tail for diagnostics; non-JSON stdout noise
		// is filtered by ndJsonStream (a bad line just fails to parse).
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString()
			this._stderrTail = (this._stderrTail + text).slice(-STDERR_TAIL_BYTES)
		})
		// EPIPE on the input pipe when the agent dies: ignore, the exit handler
		// rejects pending operations with real diagnostics.
		child.stdin?.on("error", () => {})
		return child
	}

	// -- internal: timeouts and abort ----------------------------------------

	private _withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout>
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(new Error(`${label} timed out after ${ms}ms`))
			}, ms)
		})
		return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
	}

	private _withAbortRejection<T>(promise: Promise<T>): Promise<T> {
		if (this._aborted) {
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

	private _rejectPending(err: Error): void {
		if (this._pendingReject) {
			const fn = this._pendingReject
			this._pendingReject = undefined
			fn(err)
		}
	}

	// -- internal: ACP notification handling ---------------------------------

	private _handleSessionUpdate(params: SessionNotification): Promise<void> {
		this._options.callbacks?.onRawNotification?.(params)
		const cb = this._options.callbacks
		if (!cb) return Promise.resolve()

		const update = params.update
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
		// Mirrors the sandbox client's table: in_progress = start,
		// completed/failed = end. toolName carries the display title.
		if (status === "in_progress" || status === "completed" || status === "failed") {
			cb.onToolActivity?.({ toolName: title, status })
		}
	}

	/**
	 * Permission requests from the external agent.
	 *
	 * Default deny — auto-approving would grant unauthorised access through a
	 * process we do not control. "allow" is an explicit per-server opt-in for
	 * trusted local agents; it selects the agent's first offered option.
	 */
	private _handleRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		if (this._options.permissions === "allow" && params.options.length > 0) {
			return Promise.resolve({
				outcome: { outcome: "selected", optionId: params.options[0].optionId },
			})
		}
		return Promise.resolve({ outcome: { outcome: "cancelled" } })
	}
}
