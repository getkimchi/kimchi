// ACP (Agent Client Protocol) mode: JSON-RPC 2.0 over stdio using
// @agentclientprotocol/sdk. Lets Zed / openclaw drive kimchi in-process.

import { Readable, Writable } from "node:stream"
import {
	type Agent,
	AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type CancelNotification,
	type ContentBlock,
	type InitializeRequest,
	type InitializeResponse,
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
import {
	type AgentSession,
	type AgentSessionEvent,
	DefaultResourceLoader,
	type ExtensionFactory,
	SettingsManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent"

/**
 * Produces a ready-to-use AgentSession for a newSession request. The returned
 * session must already have its model verified and extensions bound. Exposed
 * so tests can inject fakes; production uses {@link defaultSessionFactory}.
 */
export type AcpSessionFactory = (params: NewSessionRequest) => Promise<AgentSession>

export interface RunAcpOptions {
	extensionFactories: ExtensionFactory[]
	agentDir: string
	/** Override for tests. Defaults to the pi-coding-agent-backed factory. */
	sessionFactory?: AcpSessionFactory
}

type TurnContext = {
	cancelled: boolean
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

type SessionEntry = {
	session: AgentSession
	unsubscribe: () => void
	turn?: TurnContext
}

export class KimchiAcpAgent implements Agent {
	private sessions = new Map<string, SessionEntry>()
	private readonly sessionFactory: AcpSessionFactory
	// Track non-text prompt block types we've already warned about so a
	// misbehaving client that sends 1000 image blocks doesn't flood stderr.
	private warnedBlockTypes = new Set<string>()
	private shutdownPromise: Promise<void> | undefined

	constructor(
		private readonly conn: AgentSideConnection,
		options: RunAcpOptions,
	) {
		this.sessionFactory = options.sessionFactory ?? defaultSessionFactory(options)
	}

	async initialize(_: InitializeRequest): Promise<InitializeResponse> {
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { image: false, audio: false, embeddedContext: false },
			},
			authMethods: [],
		}
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

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const entry = this.sessions.get(params.sessionId)
		if (!entry) {
			throw RequestError.invalidParams(undefined, `unknown sessionId ${params.sessionId}`)
		}
		if (entry.turn) {
			throw RequestError.invalidRequest(undefined, "a prompt is already in progress for this session")
		}
		// Capabilities declare image/audio/embeddedContext: false, so a compliant
		// client will only send text blocks. A misbehaving client that sends other
		// block types gets them dropped — warn once per unseen type so the silent
		// empty-turn isn't confusing to debug.
		for (const b of params.prompt) {
			if (b.type !== "text" && !this.warnedBlockTypes.has(b.type)) {
				this.warnedBlockTypes.add(b.type)
				process.stderr.write(`acp prompt: dropping unsupported block type "${b.type}"\n`)
			}
		}
		const text = params.prompt
			.map((b: ContentBlock) => (b.type === "text" ? b.text : ""))
			.join("")
			.trim()
		if (!text) {
			return { stopReason: "end_turn" }
		}
		let turnResolve!: (r: PromptResponse) => void
		let turnReject!: (e: unknown) => void
		const result = new Promise<PromptResponse>((resolve, reject) => {
			turnResolve = resolve
			turnReject = reject
		})
		entry.turn = { cancelled: false, turnActive: false, resolve: turnResolve, reject: turnReject }
		// Kick off session.prompt but don't await inside the async function body —
		// shutdown() needs to be able to reject `result` and have the caller's await
		// on prompt() settle immediately, which can't happen while this body is
		// paused on `await session.prompt()`. Instead, attach handlers that drive
		// finalizeTurn/failTurn and return `result` directly; settling `result`
		// propagates to the caller regardless of whether session.prompt ever resolves.
		entry.session.prompt(text, { source: "rpc" }).then(
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

	private finalizeTurn(entry: SessionEntry, stopReason: PromptResponse["stopReason"]): void {
		const turn = entry.turn
		if (!turn) return
		entry.turn = undefined
		turn.resolve({ stopReason })
	}

	private failTurn(entry: SessionEntry, err: unknown): void {
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
	subagent: "think",
}
const TITLE_MAX = 80

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const truncate = (s: string): string => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX)}…` : s)

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
