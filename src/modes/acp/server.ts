// ACP (Agent Client Protocol) mode: JSON-RPC 2.0 over stdio using
// @agentclientprotocol/sdk. Lets Zed / openclaw drive kimchi in-process.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import {
	type SessionInfo as AcpSessionInfo,
	type Agent,
	AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type CancelNotification,
	type ContentBlock,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type NewSessionRequest,
	type NewSessionResponse,
	PROTOCOL_VERSION,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type SessionModelState,
	type SessionNotification,
	type SetSessionModelRequest,
	type SetSessionModelResponse,
	type ToolCallContent,
	type ToolCallLocation,
	type ToolKind,
	ndJsonStream,
} from "@agentclientprotocol/sdk"
import type { ImageContent } from "@earendil-works/pi-ai"
import {
	type AgentSession,
	type AgentSessionEvent,
	AuthStorage,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRegistry,
	type SessionInfo as PiSessionInfo,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent"
import { isHideThinkingEnabled } from "../../extensions/hide-thinking.js"

/**
 * Produces a ready-to-use AgentSession for a newSession request. The returned
 * session must already have its model verified and extensions bound. Exposed
 * so tests can inject fakes; production uses {@link defaultSessionFactory}.
 */
export type AcpSessionFactory = (params: NewSessionRequest) => Promise<AgentSession>

/**
 * Enumerates persisted sessions for a listSessions request. Mirrors pi's
 * SessionManager.list/listAll seam so tests can stub disk access.
 */
export type AcpSessionLister = (params: ListSessionsRequest) => Promise<PiSessionInfo[]>

/**
 * Opens a persisted session for a loadSession request. The returned AgentSession
 * must already be fully wired (model verified, extensions bound) and seeded
 * with the on-disk transcript; the agent only handles registration, replay,
 * and response shaping. Exposed so tests can stub disk access.
 */
export type AcpSessionLoader = (params: LoadSessionRequest) => Promise<AgentSession>

export interface RunAcpOptions {
	extensionFactories: ExtensionFactory[]
	agentDir: string
	/** Override for tests. Defaults to the pi-coding-agent-backed factory. */
	sessionFactory?: AcpSessionFactory
	/** Override for tests. Defaults to {@link defaultSessionLister}. */
	sessionLister?: AcpSessionLister
	/** Override for tests. Defaults to {@link defaultSessionLoader}. */
	sessionLoader?: AcpSessionLoader
}

type TurnContext = {
	cancelled: boolean
	hiddenToolCallIds: Set<string>
	// True once ANY turn-lifecycle event has been delivered to our subscriber
	// (agent_start, message_update, tool_execution_start, tool_execution_update).
	// Used by prompt()'s short-circuit detector to tell "session.prompt() ran
	// agent.prompt and events are flowing" from "session.prompt() short-circuited
	// before agent events ever fired". Originally this tracked only agent_start —
	// defensive widening so a future pi-mono emit-order change can't make real
	// turns look like short-circuits.
	turnActive: boolean
	resolve: (res: PromptResponse) => void
	reject: (err: unknown) => void
}

type SessionRecord = {
	session: AgentSession
	unsubscribe: () => void
	turn?: TurnContext
}

export class KimchiAcpAgent implements Agent {
	private sessions = new Map<string, SessionRecord>()
	private readonly sessionFactory: AcpSessionFactory
	private readonly agentDir: string
	private readonly sessionLister: AcpSessionLister
	private readonly sessionLoader: AcpSessionLoader
	// Track non-text prompt block types we've already warned about so a
	// misbehaving client that sends 1000 image blocks doesn't flood stderr.
	private warnedBlockTypes = new Set<string>()
	private shutdownPromise: Promise<void> | undefined

	constructor(
		private readonly conn: AgentSideConnection,
		options: RunAcpOptions,
	) {
		this.sessionFactory = options.sessionFactory ?? defaultSessionFactory(options)
		this.agentDir = options.agentDir
		this.sessionLister = options.sessionLister ?? defaultSessionLister(options)
		this.sessionLoader = options.sessionLoader ?? defaultSessionLoader(options)
	}

	async initialize(_: InitializeRequest): Promise<InitializeResponse> {
		const authStorage = AuthStorage.create(join(this.agentDir, "auth.json"))
		const modelRegistry = ModelRegistry.create(authStorage, join(this.agentDir, "models.json"))
		const supportsImages = modelRegistry.getAvailable().some((m) => m.input?.includes("image"))
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: true,
				// `list: {}` advertises support for session/list per spec
				// (SessionListCapabilities is `{ _meta? }` — empty object means
				// "supported"). loadSession remains the top-level flag because
				// the spec hasn't unified it under sessionCapabilities yet.
				sessionCapabilities: { list: {} },
				promptCapabilities: { image: supportsImages, audio: false, embeddedContext: false },
			},
			authMethods: [],
		}
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		// `additionalDirectories` is @experimental in the SDK and pi's SessionInfo
		// has no slot for additional roots, so we accept the field but don't
		// filter on it — rejecting would break Zed clients that send it
		// optimistically. Cursor pagination is also out of scope for v1: pi reads
		// only JSONL headers, so even four-digit session counts comfortably meet
		// the 500ms NFR (revisit only if real installs hit slowness).
		const piSessions = await this.sessionLister(params)
		const sessions = piSessions.map(toAcpSessionInfo)
		// Sort newest-first by updatedAt so Zed's picker surfaces recent threads
		// at the top without client-side sorting.
		sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
		return { sessions }
	}

	async authenticate(_: AuthenticateRequest): Promise<AuthenticateResponse> {
		return {}
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		// mcpServers isn't plumbed: kimchi loads MCP servers from its own config via
		// mcpAdapterExtension, so a caller-supplied list would be silently ignored.
		// Surface that as invalidParams instead of accepting the request and
		// pretending those servers are live.
		if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
			throw RequestError.invalidParams(
				undefined,
				"mcpServers is not supported; configure MCP servers via kimchi config",
			)
		}
		const session = await this.sessionFactory(params)
		// Once the factory hands us a live session we own its lifecycle. If subscribe or
		// the registering Map.set throws before we hand it back to the caller, nothing
		// else will ever dispose it — so make ownership transfer atomic.
		try {
			const sessionId = session.sessionId
			const unsubscribe = session.subscribe((event) => this.onSessionEvent(sessionId, event))
			this.sessions.set(sessionId, { session, unsubscribe })
			const models = buildSessionModelState(session)
			return { sessionId, models }
		} catch (err) {
			session.dispose()
			throw err
		}
	}

	async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
		const entry = this.sessions.get(params.sessionId)
		if (!entry) {
			throw RequestError.invalidParams(undefined, `unknown sessionId ${params.sessionId}`)
		}
		if (entry.turn) {
			throw RequestError.invalidRequest(undefined, "a prompt is already in progress for this session")
		}
		const { session } = entry
		const availableModels = session.modelRegistry.getAvailable()
		const selectedModel = availableModels.find((m) => getAcpModelId(m) === params.modelId)
		if (!selectedModel) {
			throw RequestError.invalidParams(undefined, `Unknown or unavailable model: ${params.modelId}`)
		}
		try {
			await session.setModel(selectedModel)
		} catch (err) {
			if (err instanceof RequestError) {
				throw err
			}
			throw RequestError.invalidParams(
				undefined,
				`Failed to switch model: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
		return {}
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		// Same posture as newSession: mcpServers isn't plumbed, surface as
		// invalidParams instead of silently dropping caller intent.
		if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
			throw RequestError.invalidParams(
				undefined,
				"mcpServers is not supported; configure MCP servers via kimchi config",
			)
		}
		// Reject re-load of an already-live session: pi's JSONL is append-only and
		// two writers on the same file would interleave entries unpredictably. Zed
		// should close the live session before reloading. invalidRequest (-32600)
		// signals "method valid but state forbids it now".
		if (this.sessions.has(params.sessionId)) {
			throw RequestError.invalidRequest(undefined, `session ${params.sessionId} is already loaded; close it first`)
		}
		const session = await this.sessionLoader(params)
		// Atomic ownership transfer mirrors newSession but covers the full
		// register → replay → respond path: a throw at any point after the
		// loader hands back a live session must unwind registration AND dispose,
		// otherwise the session sits in `sessions` while loadSession rejects —
		// Zed thinks load failed but the agent thinks the id is live, and the
		// next loadSession for the same id wrongly returns invalidRequest.
		const sid = session.sessionId
		// Defensive: pi reads the sessionId from the JSONL header, not the
		// filename, so a corrupted / hand-edited session whose header id
		// disagrees with the requested id would land under the wrong key in
		// `sessions`. Subsequent session/prompt for params.sessionId would then
		// fail with "unknown sessionId" while the file is still held open.
		// Reject up front and dispose so we don't quietly diverge.
		if (sid !== params.sessionId) {
			session.dispose()
			throw RequestError.invalidParams(
				undefined,
				`session header id ${sid} does not match requested sessionId ${params.sessionId}`,
			)
		}
		try {
			const unsubscribe = session.subscribe((event) => this.onSessionEvent(sid, event))
			this.sessions.set(sid, { session, unsubscribe })
			// Replay BEFORE the response resolves so Zed sees a coherent transcript
			// when the loadSession promise settles. No turn context is created, so a
			// concurrent session/cancel during replay is a no-op (matches the PRD
			// invariant: "A turn must not be considered active during replay").
			this.replayTranscript(session)
			return { models: this.modelStateForSession(session) }
		} catch (err) {
			const existing = this.sessions.get(sid)
			if (existing) {
				this.sessions.delete(sid)
				existing.unsubscribe()
			}
			session.dispose()
			throw err
		}
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const entry = this.sessions.get(params.sessionId)
		if (!entry) {
			throw RequestError.invalidParams(undefined, `unknown sessionId ${params.sessionId}`)
		}
		if (entry.turn) {
			throw RequestError.invalidRequest(undefined, "a prompt is already in progress for this session")
		}
		// Image support is per-model; check if active model supports vision input.
		const supportsImages = entry.session.model?.input?.includes("image") ?? false
		// Warn about unsupported block types (audio, embeddedContext) once per type.
		// Also warn when dropping image blocks for non-vision models.
		for (const b of params.prompt) {
			if (b.type !== "text" && (b.type !== "image" || !supportsImages) && !this.warnedBlockTypes.has(b.type)) {
				this.warnedBlockTypes.add(b.type)
				const reason = b.type === "image" ? "active model has no vision input" : "unsupported block type"
				process.stderr.write(`acp prompt: dropping ${b.type} block (${reason})\n`)
			}
		}
		const text = params.prompt
			.map((b: ContentBlock) => (b.type === "text" ? b.text : ""))
			.join("")
			.trim()
		// Extract image blocks from the prompt only if model supports vision.
		const images: ImageContent[] = supportsImages
			? params.prompt
					.filter((b: ContentBlock): b is ContentBlock & { type: "image" } => b.type === "image")
					.map((b) => ({
						type: "image" as const,
						data: b.data,
						mimeType: b.mimeType,
					}))
			: []
		if (!text && images.length === 0) {
			return { stopReason: "end_turn" }
		}
		let turnResolve!: (r: PromptResponse) => void
		let turnReject!: (e: unknown) => void
		const result = new Promise<PromptResponse>((resolve, reject) => {
			turnResolve = resolve
			turnReject = reject
		})
		entry.turn = {
			cancelled: false,
			hiddenToolCallIds: new Set(),
			turnActive: false,
			resolve: turnResolve,
			reject: turnReject,
		}
		// Kick off session.prompt but don't await inside the async function body —
		// shutdown() needs to be able to reject `result` and have the caller's await
		// on prompt() settle immediately, which can't happen while this body is
		// paused on `await session.prompt()`. Instead, attach handlers that drive
		// finalizeTurn/failTurn and return `result` directly; settling `result`
		// propagates to the caller regardless of whether session.prompt ever resolves.
		entry.session.prompt(text, { source: "rpc", images }).then(
			() => {
				// pi-coding-agent's session.prompt() short-circuits for extension commands,
				// input-handler intercepts, and no-op paths — in those cases agent.prompt()
				// never runs and no agent events fire. For real turns it awaits agent.prompt()
				// which emits agent_start first and agent_end last (pi-agent-core contract:
				// types.d.ts "agent_end is the last event emitted for a run"). By the time
				// agent.prompt() resolves, our subscriber has been called with at least
				// agent_start — agent.prompt awaits the LLM call, draining the microtask
				// queue. agent_end delivery can still race with session.prompt()'s resolution
				// because _processAgentEvent awaits extension handlers before calling our
				// listener. So: if ANY turn-lifecycle event was observed (turnActive), trust
				// the agent_end contract and let the subscriber finalize the turn. Otherwise
				// the turn short-circuited and we synthesize end_turn here.
				if (entry.turn && !entry.turn.turnActive) {
					this.finalizeTurn(entry, "end_turn")
				}
			},
			(err) => {
				// If cancel() arrived mid-turn, session.prompt() may reject with an abort
				// error instead of resolving and letting agent_end drive finalization. The
				// spec still says the client-initiated cancel should surface as
				// stopReason: "cancelled", not a JSON-RPC error — so swallow the abort
				// and resolve with the expected stop reason. Any other error propagates.
				// shutdown() may have already failed the turn; failTurn is a no-op in that case.
				if (!entry.turn) return
				if (entry.turn.cancelled) {
					this.finalizeTurn(entry, "cancelled")
				} else {
					this.failTurn(entry, err)
				}
			},
		)
		return result
	}

	async cancel(params: CancelNotification): Promise<void> {
		const entry = this.sessions.get(params.sessionId)
		if (!entry) return
		if (entry.turn) entry.turn.cancelled = true
		await entry.session.abort()
	}

	async shutdown(cause: "signal" | "disconnect" = "disconnect"): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise
		this.shutdownPromise = this.doShutdown(cause)
		return this.shutdownPromise
	}

	private async doShutdown(cause: "signal" | "disconnect"): Promise<void> {
		// Drain any in-flight turn promises before tearing down the session.
		// On the signal path we process.exit immediately so this is mostly
		// cosmetic, but runAcpMode's finally also calls shutdown when conn.closed
		// resolves — in that window a pending PromptResponse would otherwise hang
		// until process exit. Reject symmetrically so the caller's await settles.
		for (const entry of this.sessions.values()) {
			if (entry.turn) this.failTurn(entry, new Error("acp agent shutting down"))
			entry.unsubscribe()
			// Emit session_shutdown to extensions and await all handlers before
			// calling dispose(). dispose() is synchronous and returns void, so
			// async extension handlers (e.g. telemetry drain, shutdown marker)
			// would be fire-and-forgotten if we relied on dispose() alone.
			await entry.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
			entry.session.dispose()
		}
		this.sessions.clear()
	}

	private onSessionEvent(sessionId: string, event: AgentSessionEvent): void {
		const entry = this.sessions.get(sessionId)
		if (!entry) return
		const turn = entry.turn
		switch (event.type) {
			case "agent_start": {
				if (turn) turn.turnActive = true
				return
			}
			case "message_update": {
				if (!turn) return
				turn.turnActive = true
				const ame = event.assistantMessageEvent
				if (ame.type === "text_delta" && ame.delta) {
					this.send({
						sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: ame.delta },
						},
					})
				} else if (ame.type === "thinking_delta" && ame.delta) {
					this.send({
						sessionId,
						update: {
							sessionUpdate: "agent_thought_chunk",
							content: { type: "text", text: ame.delta },
						},
					})
				}
				return
			}
			case "tool_execution_start": {
				// Symmetry with the other turn-lifecycle branches: if the turn was
				// already finalized (e.g., shutdown cleared it), don't emit stray
				// tool_call notifications the client would have to reconcile against
				// a turn it already considers over.
				if (!turn) return
				turn.turnActive = true
				if (isHiddenToolCall(event.toolName, event.args)) {
					turn.hiddenToolCallIds.add(event.toolCallId)
					return
				}
				const { title, kind, locations } = describeToolCall(event.toolName, event.args)
				this.send({
					sessionId,
					update: {
						sessionUpdate: "tool_call",
						toolCallId: event.toolCallId,
						title,
						kind,
						status: "in_progress",
						locations,
						rawInput: event.args,
					},
				})
				return
			}
			case "tool_execution_update": {
				if (!turn) return
				turn.turnActive = true
				if (turn.hiddenToolCallIds.has(event.toolCallId) || isHiddenToolCall(event.toolName, event.args)) {
					turn.hiddenToolCallIds.add(event.toolCallId)
					return
				}
				const partial = toolResultContent(event.partialResult)
				if (partial.length === 0) return
				this.send({
					sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: event.toolCallId,
						status: "in_progress",
						content: partial,
					},
				})
				return
			}
			case "tool_execution_end": {
				if (!turn) return
				if (turn.hiddenToolCallIds.has(event.toolCallId)) {
					turn.hiddenToolCallIds.delete(event.toolCallId)
					return
				}
				this.send({
					sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: event.toolCallId,
						status: event.isError ? "failed" : "completed",
						content: toolResultContent(event.result),
						rawOutput: event.result,
					},
				})
				return
			}
			case "agent_end": {
				// If no turn is active, this is a late agent_end after the prompt
				// handler already synthesized end_turn (short-circuit path that
				// nevertheless emitted events somehow) — safe to drop.
				if (!turn) return
				this.finalizeTurn(entry, turn.cancelled ? "cancelled" : "end_turn")
				return
			}
			default:
				return
		}
	}

	// Phase 3 replay: walk the persisted transcript on the leaf path and emit
	// session/update notifications per content block — text, thinking, tool
	// calls. Tool results are paired with their originating toolCall by id so
	// the historical tool render shape (tool_call + terminal tool_call_update)
	// matches what live turns produce. Compaction / branch_summary /
	// model_change / custom entries emit nothing per PRD — using getBranch()
	// (raw entries) instead of buildSessionContext() avoids surfacing
	// compaction summaries as synthetic user messages.
	//
	// Notifications go straight from this method to conn.sessionUpdate; we do
	// NOT replay through the AgentSession event emitter, so extensions like
	// telemetryExtension don't double-count historical turns.
	private replayTranscript(session: AgentSession): void {
		const sessionId = session.sessionId
		const entries = session.sessionManager.getBranch()
		const toolResults = collectToolResults(entries)
		for (const entry of entries) {
			if (entry.type !== "message") continue
			const msg = entry.message
			if (msg.role === "user") {
				const text = userMessageText(msg.content)
				if (!text) continue
				this.send({
					sessionId,
					update: {
						sessionUpdate: "user_message_chunk",
						content: { type: "text", text },
					},
				})
			} else if (msg.role === "assistant") {
				this.replayAssistantBlocks(sessionId, msg.content, toolResults)
			}
			// toolResult: handled inline alongside its originating toolCall above.
		}
	}

	private replayAssistantBlocks(sessionId: string, content: unknown, toolResults: Map<string, ReplayToolResult>): void {
		if (!Array.isArray(content)) return
		// Buffer contiguous text blocks so a single assistant message renders as
		// one agent_message_chunk per natural text segment (PRD: "emit the full
		// message as a single chunk — no per-token chunking"). When a thinking
		// or toolCall block interrupts the run, flush the buffered text first so
		// ordering relative to those structural blocks is preserved.
		let textBuffer = ""
		const flushText = () => {
			if (textBuffer.length === 0) return
			this.send({
				sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: textBuffer },
				},
			})
			textBuffer = ""
		}
		for (const block of content) {
			if (!block || typeof block !== "object") continue
			const b = block as { type?: string }
			if (b.type === "text") {
				const text = (b as { text?: unknown }).text
				if (typeof text !== "string" || text.length === 0) continue
				// Persisted text from hide-thinking-aware models can carry ANSI
				// dim escapes around inner thinking content (the live TUI renders
				// them; ACP clients can't). Strip before sending — see stripAnsi.
				textBuffer += stripAnsi(text)
			} else if (b.type === "thinking") {
				flushText()
				const thinking = (b as { thinking?: unknown; redacted?: unknown }).thinking
				const redacted = (b as { redacted?: unknown }).redacted === true
				// Redacted thinking has no plaintext to surface — the encrypted
				// payload only matters for multi-turn provider continuity.
				if (redacted) continue
				if (typeof thinking !== "string" || thinking.length === 0) continue
				if (!shouldEmitThinking(thinking)) continue
				this.send({
					sessionId,
					update: {
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: stripAnsi(thinking) },
					},
				})
			} else if (b.type === "toolCall") {
				flushText()
				const tc = b as { id?: unknown; name?: unknown; arguments?: unknown }
				const id = typeof tc.id === "string" ? tc.id : undefined
				const name = typeof tc.name === "string" ? tc.name : undefined
				if (!id || !name) continue
				const args = (tc.arguments ?? {}) as Record<string, unknown>
				if (isHiddenToolCall(name, args)) continue
				const result = toolResults.get(id)
				// No persisted result → the call never finished (interrupted mid
				// turn). "failed" is the closest terminal status; leaving the call
				// in_progress would hang the client's spinner forever on replay.
				const status: "completed" | "failed" = result ? (result.isError ? "failed" : "completed") : "failed"
				const { title, kind, locations } = describeToolCall(name, args)
				this.send({
					sessionId,
					update: {
						sessionUpdate: "tool_call",
						toolCallId: id,
						title,
						kind,
						status,
						locations,
						rawInput: args,
					},
				})
				this.send({
					sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: id,
						status,
						content: result ? toolResultContent(result) : [],
						rawOutput: result,
					},
				})
			}
		}
		// Trailing text after the last structural block (or a text-only message)
		// still needs to land — flushText is a no-op when the buffer is empty.
		flushText()
	}

	private modelStateForSession(session: AgentSession): SessionModelState | null {
		return buildSessionModelState(session)
	}

	private send(params: SessionNotification): void {
		// Fire-and-forget is safe here because the ACP SDK chains every outbound
		// message onto a shared writeQueue Promise (see @agentclientprotocol/sdk
		// acp.js#sendMessage), so two consecutive sessionUpdate() calls are
		// written to the stream in the order we invoked them even though we
		// don't await. Do NOT "fix" this into `await this.conn.sessionUpdate(...)`
		// in onSessionEvent — the subscriber is called synchronously from the
		// AgentSession event emitter, and awaiting inside it would back-pressure
		// every subsequent event through the event loop, which pi-mono's
		// _processAgentEvent does not expect.
		this.conn.sessionUpdate(params).catch((err: unknown) => {
			process.stderr.write(`acp sessionUpdate failed: ${String(err)}\n`)
		})
	}

	private finalizeTurn(entry: SessionRecord, stopReason: PromptResponse["stopReason"]): void {
		const turn = entry.turn
		if (!turn) return
		entry.turn = undefined
		turn.resolve({ stopReason })
	}

	private failTurn(entry: SessionRecord, err: unknown): void {
		const turn = entry.turn
		if (!turn) return
		entry.turn = undefined
		turn.reject(err)
	}
}

// Exported for testing. In practice the only way model is missing here is a
// missing / unusable credential: loadConfig() already threw on an absent
// KIMCHI_API_KEY before we ever spawned the ACP loop, and updateModelsConfig
// falls back to defaults rather than failing. authRequired (-32000) nudges
// Zed toward an auth prompt instead of showing a generic "internal error".
export function buildSessionModelState(
	session: Pick<AgentSession, "model" | "modelRegistry">,
): SessionModelState | null {
	const currentModel = session.model
	if (!currentModel) {
		return null
	}
	const availableModels = session.modelRegistry.getAvailable()
	return {
		currentModelId: getAcpModelId(currentModel),
		availableModels: availableModels.map((m) => ({
			modelId: getAcpModelId(m),
			name: m.name,
		})),
	}
}

function getAcpModelId(model: Pick<NonNullable<AgentSession["model"]>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`
}

export function assertSessionHasModel(session: Pick<AgentSession, "model">): void {
	if (!session.model) {
		throw RequestError.authRequired(
			undefined,
			"No model available for ACP session. Configure an API key or models.json first.",
		)
	}
}

// Title falls back to the truncated first user message when the session has no
// user-defined name. ACP clients render this in the thread-picker UI; we do
// NOT trigger a fresh prompt-summary on listSessions because that would mean
// an LLM call per session and break the 500ms NFR.
export function toAcpSessionInfo(info: PiSessionInfo): AcpSessionInfo {
	// Use truthiness rather than `??` so an empty `name` (migration artifact or
	// hand-edited session-info entry) still falls through to firstMessage —
	// `??` only short-circuits on null/undefined and would otherwise leave the
	// title as the empty string and end up null below.
	const fallback = info.firstMessage ? truncate(info.firstMessage) : ""
	const title = info.name && info.name.length > 0 ? info.name : fallback
	return {
		sessionId: info.id,
		cwd: info.cwd,
		title: title.length > 0 ? title : null,
		updatedAt: info.modified.toISOString(),
	}
}

// Mirrors pi's getDefaultSessionDir (core/session-manager.js): pi declares the
// helper but doesn't re-export it from the package index. Replicated inline so
// listSessions points at kimchi's agentDir (~/.config/kimchi/harness/sessions/...)
// instead of pi's own ~/.pi/agent/sessions/... — pi reads PI_CODING_AGENT_DIR,
// not KIMCHI_CODING_AGENT_DIR, so without explicit sessionDir threading the
// default lookup misses every kimchi session. Encoding is a public on-disk
// format; drift surfaces as "no sessions found" rather than silent corruption.
function encodeCwdDir(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

function defaultSessionLister(options: RunAcpOptions): AcpSessionLister {
	return async (params: ListSessionsRequest) => {
		if (params.cwd) {
			return SessionManager.list(params.cwd, join(options.agentDir, "sessions", encodeCwdDir(params.cwd)))
		}
		// listAll has no agentDir slot in pi today, so a non-default agentDir
		// won't be honored for the unscoped path. Acceptable v1 limitation:
		// Zed's thread-import always supplies a cwd.
		return SessionManager.listAll()
	}
}

function defaultSessionLoader(options: RunAcpOptions): AcpSessionLoader {
	return async (params: LoadSessionRequest): Promise<AgentSession> => {
		const cwd = params.cwd
		// Mirror defaultSessionLister: encode cwd inline because pi doesn't
		// re-export getDefaultSessionDir from its package index. Threading
		// agentDir explicitly is load-bearing — pi reads PI_CODING_AGENT_DIR,
		// not KIMCHI_CODING_AGENT_DIR, so default lookups would miss kimchi
		// sessions stored under the kimchi agent dir.
		const sessionDir = join(options.agentDir, "sessions", encodeCwdDir(cwd))
		const sessionPath = join(sessionDir, `${params.sessionId}.jsonl`)
		// existsSync is the simplest way to map "session not found" to
		// invalidParams — SessionManager.open would silently start a fresh
		// session on a missing/empty file (and rewrite the file with a new id),
		// which is destructive and not what loadSession should do.
		if (!existsSync(sessionPath)) {
			throw RequestError.invalidParams(undefined, `session ${params.sessionId} not found`)
		}
		let sessionManager: SessionManager
		try {
			// Open WITHOUT cwdOverride so the on-disk header cwd is preserved —
			// pi's open is `cwd = cwdOverride ?? header.cwd ?? process.cwd()`
			// (no comparison), so passing params.cwd upfront would silently
			// re-root a session created elsewhere. We compare below instead.
			sessionManager = SessionManager.open(sessionPath, sessionDir)
		} catch (err) {
			// loadEntriesFromFile silently skips malformed lines, but I/O
			// errors (permissions, post-existsSync delete) and migration
			// failures still propagate. Surface as invalidParams with a
			// one-line message instead of crashing the connection (which
			// triggers Zed's "server shut down unexpectedly" toast).
			const msg = err instanceof Error ? err.message : String(err)
			throw RequestError.invalidParams(undefined, `failed to open session: ${msg}`)
		}
		// Reject cwd mismatch so a session created for one project can't be
		// silently re-rooted into another. The PRD's "project moved on disk"
		// case isn't supported in v1 — clients must load against the original
		// workspace, or pi's listAll surfaces the canonical cwd.
		const sessionCwd = sessionManager.getCwd()
		if (sessionCwd !== cwd) {
			throw RequestError.invalidParams(undefined, `session cwd ${sessionCwd} does not match requested cwd ${cwd}`)
		}
		const settingsManager = SettingsManager.create(cwd, options.agentDir)
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: options.agentDir,
			settingsManager,
			extensionFactories: options.extensionFactories,
		})
		await resourceLoader.reload()
		const { session } = await createAgentSession({
			cwd,
			agentDir: options.agentDir,
			settingsManager,
			resourceLoader,
			sessionManager,
		})
		try {
			assertSessionHasModel(session)
			await session.bindExtensions({
				onError: (err) => {
					process.stderr.write(`acp ext error [${err.extensionPath}] ${err.event}: ${err.error}\n`)
				},
			})
			return session
		} catch (err) {
			session.dispose()
			throw err
		}
	}
}

function defaultSessionFactory(options: RunAcpOptions): AcpSessionFactory {
	return async (params: NewSessionRequest): Promise<AgentSession> => {
		const cwd = params.cwd ?? process.cwd()
		const settingsManager = SettingsManager.create(cwd, options.agentDir)
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: options.agentDir,
			settingsManager,
			extensionFactories: options.extensionFactories,
		})
		await resourceLoader.reload()
		const { session } = await createAgentSession({
			cwd,
			agentDir: options.agentDir,
			settingsManager,
			resourceLoader,
		})
		// From this point the session holds resources (extension loaders, model
		// clients). Any failure on the setup path — model check or bindExtensions —
		// must dispose before rethrowing, otherwise we leak on the newSession error
		// path where the caller never sees a sessionId to clean up.
		try {
			assertSessionHasModel(session)
			await session.bindExtensions({
				onError: (err) => {
					process.stderr.write(`acp ext error [${err.extensionPath}] ${err.event}: ${err.error}\n`)
				},
			})
			return session
		} catch (err) {
			session.dispose()
			throw err
		}
	}
}

// Mirrors the tool names kimchi actually exposes: pi-coding-agent core tools
// plus the kimchi extensions in src/extensions (web-fetch, web-search, Agent).
// ACP clients key UI affordances (icon, grouping, permission messaging) off the
// kind field, so every registered tool should map to the most specific kind in
// the ToolKind vocabulary before falling back to "other". MCP tools arrive with
// dynamic `mcp__server__name` identifiers we can't enumerate statically — those
// still hit the "other" fallback in describeToolCall().
const TOOL_KINDS: Record<string, ToolKind> = {
	bash: "execute",
	read: "read",
	ls: "read",
	grep: "search",
	find: "search",
	edit: "edit",
	write: "edit",
	web_fetch: "fetch",
	web_search: "search",
	Agent: "think",
}
const TITLE_MAX = 80

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const truncate = (s: string): string => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX)}…` : s)

export function isHiddenToolCall(toolName: string, args: unknown): boolean {
	// Defense-in-depth: the Agent tool's public schema deliberately omits `visibility`
	// (see src/extensions/agents/index.ts:execute), so this normally returns false. If a
	// misbehaving LLM emits the field anyway, we hide the ACP-side tool_call rather than
	// trust the schema to have caught it.
	if (toolName !== "Agent") return false
	const a = (args ?? {}) as Record<string, unknown>
	return typeof a.visibility === "string" && a.visibility.toLowerCase() === "system"
}

// Persisted assistant text from hide-thinking-aware models (DeepSeek, QwQ, …)
// can contain ANSI dim escapes wrapping inner <think> content — the live TUI
// renders them, but ACP clients receive raw text and would surface the
// escapes verbatim. Strip a conservative subset (CSI sequences) so the user
// sees plain text on replay; ACP's text content type carries no styling.
// Built from String.fromCharCode to keep the literal ESC byte out of source —
// biome's noControlCharactersInRegex flags it inside a regex literal.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`, "g")
export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "")
}

export function describeToolCall(
	toolName: string,
	args: unknown,
): { title: string; kind: ToolKind; locations: ToolCallLocation[] } {
	const a = (args ?? {}) as Record<string, unknown>
	const path = asString(a.file_path) ?? asString(a.path)
	const command = asString(a.command)
	const pattern = asString(a.pattern)
	// title carries the target/argument only; the ACP `kind` field drives the verb
	// and icon on the client side. Bash puts its command here; file ops put the
	// path; search ops put the pattern. Falls back to the tool name when we have
	// no specific argument to show. Truncate every branch so a long absolute
	// path or regex doesn't blow up client UIs (locations[].path keeps the full
	// value for clients that want it).
	const rawTitle = toolName === "bash" && command ? command : (path ?? pattern ?? toolName)
	return {
		title: truncate(rawTitle),
		kind: TOOL_KINDS[toolName] ?? "other",
		locations: path ? [{ path }] : [],
	}
}

// UserMessage.content is `string | (TextContent | ImageContent)[]` per pi-ai
// types. For Phase 2 replay we only surface text — Zed has no UX surface for
// historical image attachments, and the prompt capabilities advertise
// image: false so a future replay path that emits historical images would
// also need to flip that flag.
export function userMessageText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	const parts: string[] = []
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text
			if (typeof text === "string") parts.push(text)
		}
	}
	return parts.join("")
}

// AssistantMessage.content is `(TextContent | ThinkingContent | ToolCall)[]`.
// Phase 2 emits only `text`; thinking/toolCall blocks are deferred to Phase 3
// so historical thinking still respects the hide-thinking redaction rules and
// historical tool calls render as proper tool_call notifications.
export function assistantMessageText(content: unknown): string {
	if (!Array.isArray(content)) return ""
	const parts: string[] = []
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text
			if (typeof text === "string") parts.push(text)
		}
	}
	return parts.join("")
}

type ReplayToolResult = {
	content?: unknown
	isError: boolean
	// Pass-through `details` so the replay's tool_call_update rawOutput carries
	// the same shape as the live path's event.result (AgentToolResult includes
	// details). Clients keying UI off rawOutput.details would otherwise see a
	// thinner payload on replay.
	details?: unknown
	toolName?: string
}

// First pass over the branch: index tool results by their toolCallId so the
// replay walker can stitch each historical toolCall block to its terminal
// outcome (status + content) in O(1). Tool results land as separate message
// entries in the JSONL — without this map we'd have to scan forward inside
// the walker on every toolCall, turning replay into O(N²).
function collectToolResults(entries: unknown[]): Map<string, ReplayToolResult> {
	const out = new Map<string, ReplayToolResult>()
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue
		const e = entry as { type?: unknown; message?: unknown }
		if (e.type !== "message") continue
		const m = e.message as
			| {
					role?: unknown
					toolCallId?: unknown
					toolName?: unknown
					content?: unknown
					details?: unknown
					isError?: unknown
			  }
			| undefined
		if (!m || m.role !== "toolResult" || typeof m.toolCallId !== "string") continue
		out.set(m.toolCallId, {
			content: m.content,
			isError: m.isError === true,
			details: m.details,
			toolName: typeof m.toolName === "string" ? m.toolName : undefined,
		})
	}
	return out
}

// Native ThinkingContent blocks aren't routed through hideThinkingExtension
// (which only mutates <think> tags inside text blocks), but the replay UX
// should still honor the user's hideThinkingBlock setting — otherwise a user
// who hides thinking sees a quiet live UI but a noisy replayed transcript.
// Read the setting directly: a previous version probed filterThinkingForDisplay
// with a synthetic <think>...</think> wrapper, which broke when the persisted
// thinking text itself contained `</think>` (the inner regex terminated early
// and the predicate falsely returned true).
export function shouldEmitThinking(_thinking: string): boolean {
	return !isHideThinkingEnabled()
}

function toolResultContent(result: unknown): ToolCallContent[] {
	// TODO: non-text blocks are silently dropped here. web_fetch can in principle
	// return image blocks, and MCP tools may return resource blocks — clients
	// would see a completed tool call with empty content. Safe today because no
	// registered tool emits non-text blocks in practice, but revisit when
	// web_fetch or an MCP tool starts returning them.
	const r = result as { content?: unknown } | null | undefined
	const content = r?.content
	if (!Array.isArray(content)) return []
	const out: ToolCallContent[] = []
	for (const block of content) {
		if (!block || typeof block !== "object") continue
		const b = block as { type?: string; text?: string }
		if (b.type === "text" && typeof b.text === "string") {
			out.push({ type: "content", content: { type: "text", text: b.text } })
		}
	}
	return out
}

export async function runAcpMode(options: RunAcpOptions): Promise<void> {
	// stdout is reserved for JSON-RPC frames; redirect stray console output to
	// stderr so a lone `console.log` anywhere in pi-mono/extensions can't corrupt
	// the protocol stream.
	console.log = console.error
	console.info = console.error
	console.warn = console.error
	console.debug = console.error

	const writable = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
	const readable = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
	const stream = ndJsonStream(writable, readable)

	let agentInstance: KimchiAcpAgent | undefined
	const conn = new AgentSideConnection((c: AgentSideConnection) => {
		agentInstance = new KimchiAcpAgent(c, options)
		return agentInstance
	}, stream)

	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP", "SIGINT"]
	let shuttingDown = false
	const onSignal = (sig: NodeJS.Signals) => {
		if (shuttingDown) return
		shuttingDown = true
		const code = sig === "SIGHUP" ? 129 : sig === "SIGINT" ? 130 : 143
		agentInstance
			?.shutdown("signal")
			.catch(() => {})
			.finally(() => process.exit(code))
	}
	for (const s of signals) process.on(s, onSignal)

	try {
		await conn.closed
	} finally {
		for (const s of signals) process.off(s, onSignal)
		await agentInstance?.shutdown()
	}
}
