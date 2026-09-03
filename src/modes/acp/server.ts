// ACP (Agent Client Protocol) mode: JSON-RPC 2.0 over stdio using
// @agentclientprotocol/sdk. Lets IDE extensions, Zed, openclaw drive kimchi in-process.

import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import {
	type SessionInfo as AcpSessionInfo,
	type Agent,
	AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type AuthMethod,
	type CancelNotification,
	type ClientCapabilities,
	type CloseSessionRequest,
	type CloseSessionResponse,
	type ContentBlock,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type LogoutRequest,
	type LogoutResponse,
	type NewSessionRequest,
	type NewSessionResponse,
	ndJsonStream,
	PROTOCOL_VERSION,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type SessionConfigOption,
	type SessionConfigSelectOption,
	type SessionModelState,
	type SessionNotification,
	type SessionUpdate,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModelRequest,
	type SetSessionModelResponse,
	type ToolCallContent,
} from "@agentclientprotocol/sdk"
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai"
import type { AgentSessionEvent, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	initTheme,
	ModelRegistry,
	ModelRuntime,
	type SessionInfo as PiSessionInfo,
	type SessionHeader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "../../cli-args.js"
import { authenticateViaBrowser } from "../../cli-auth/index.js"
import { clearApiKey, writeApiKey } from "../../config.js"
import { defaultFermentRuntime } from "../../extensions/ferment/runtime.js"
import { KIMCHI_PROVIDER_ID } from "../../extensions/login/flow.js"
import type { McpServerManager } from "../../extensions/mcp-adapter/server-manager.js"
import type { ProbeResult } from "../../extensions/mcp-adapter/types.js"
import { refFromModel, splitModelRef } from "../../extensions/model-catalog/ref-utils.js"
import { getMultiModelEnabled, setMultiModelEnabled } from "../../extensions/multi-model.js"
import { getOrchestratorModel } from "../../extensions/orchestration/model-roles.js"
import { loadConfig } from "../../extensions/permissions/config.js"
import {
	PERMISSION_MODES,
	PERMISSION_MODES_WITH_META,
	PERMISSIONS_ENV_KEY,
} from "../../extensions/permissions/constants.js"
import {
	clearPermissionModeEnv,
	createSessionPermissionFlagController,
	getPermissionMode,
	persistPermissionModeIfChanged,
	resolveInitialPermissionMode,
	setPermissionMode,
} from "../../extensions/permissions/mode-controller.js"
import {
	registerSessionPermissionFlagController,
	unregisterSessionPermissionFlagController,
} from "../../extensions/permissions/mode-controller-registry.js"
import type { PermissionMode, PermissionModeState } from "../../extensions/permissions/types.js"
import { configureHttpIdleTimeout } from "../../http/proxy.js"
import { updateModelsConfig } from "../../models.js"
import { resolveHeadlessProjectTrust } from "../../project-trust.js"
import { getVersion } from "../../utils.js"
import { createAcpPermissionPrompter } from "./acp-prompter.js"
import { createAcpUIContext } from "./acp-ui-context.js"
import { ADVERTISED_CAPABILITIES, AVAILABLE_EXT_METHODS, CAPABILITIES_KEY } from "./capabilities.js"
import { AVAILABLE_COMMANDS } from "./commands.js"
import { handleProbeMcpServer } from "./ext-methods/mcp.js"
import { handleSetSessionTitle } from "./ext-methods/set-session-title.js"
import { handleSteering } from "./ext-methods/steering.js"
import { registerAcpPrompter, unregisterAcpPrompter } from "./permission-prompter-registry.js"
import { AcpPlanTracker, type ActivePlan } from "./plans.js"
import {
	type AcpSkillInfo,
	buildSkillAvailableCommands,
	buildSkillCommandPrompt,
	buildSkillListBlock,
	discoverAcpSkillCommands,
	tryParseSkillCommand,
} from "./skill-commands.js"
import { resetAcpClientInfo, setAcpClientInfo } from "./state.js"
import { resolveAcpAppendSystemPrompt } from "./system-prompt.js"
import { buildToolCall, buildToolCallUpdate, describeToolCall, isHiddenToolCall } from "./tool-calls/utils.js"
import { asString, extractImages, truncate } from "./utils.js"

/** Auth method ID for Agent Auth (browser-based OAuth). Used in both
 * initialize() declaration and authenticate() validation to avoid typo drift. */
const KIMCHI_AGENT_AUTH_METHOD_ID = "kimchi-agent"

/** Resolve --plan/--auto/--yolo CLI flags into a PermissionMode. */
function resolveCliPermissionMode(): PermissionMode | undefined {
	const { options } = getParsedCliArgs()
	if (options.plan) return "plan"
	if (options.auto) return "auto"
	if (options.yolo) return "yolo"
	return undefined
}

/**
 * Produces an unbound AgentSession for a newSession request. The ACP agent owns
 * model verification, extension binding, ACP prompter registration, and final
 * lifecycle registration. Exposed so tests can inject fakes; production uses
 * {@link defaultSessionFactory}.
 */
export type AcpSessionFactory = (params: NewSessionRequest) => Promise<AgentSession>

/**
 * Enumerates persisted sessions for a listSessions request. Mirrors pi's
 * SessionManager.list/listAll seam so tests can stub disk access.
 */
export type AcpSessionLister = (params: ListSessionsRequest) => Promise<PiSessionInfo[]>

/**
 * Opens a persisted, unbound session for a loadSession request. The returned
 * AgentSession is seeded with the on-disk transcript; the ACP agent owns model
 * verification, extension binding, replay, and response shaping. Exposed so
 * tests can stub disk access.
 */
export type AcpSessionLoader = (params: LoadSessionRequest) => Promise<AgentSession>

export interface RunAcpOptions {
	extensionFactories: ExtensionFactory[]
	agentDir: string
	/**
	 * Content of the `--append-system-prompt` CLI flag, forwarded verbatim to
	 * every session's DefaultResourceLoader. When a client also sends
	 * `_meta["kimchi.dev"].appendSystemPrompt`, meta content is appended after this.
	 */
	appendSystemPrompt?: string[]
	/** Override for tests. Defaults to the pi-coding-agent-backed factory. */
	sessionFactory?: AcpSessionFactory
	/** Override for tests. Defaults to {@link defaultSessionLister}. */
	sessionLister?: AcpSessionLister
	/** Override for tests. Defaults to {@link defaultSessionLoader}. */
	sessionLoader?: AcpSessionLoader
	/**
	 * MCP server manager used by the `_kimchi.dev/probe_mcp_server` extMethod
	 * handler to create transient probe connections. Injected so tests can stub
	 * it; production code constructs a real McpServerManager.
	 */
	mcpServerManager?: McpServerManager
}

/**
 * Per-turn usage accumulator. pi-mono chains multiple agent.prompt /
 * agent.continue calls per turn, each producing an AssistantMessage with its
 * own pi-ai `usage`; ACP's (v1/experimental) PromptResponse.usage expects a
 * single summary, so message_end events fold their usage into this record and
 * finalizeTurn emits the summed totals. `messages` counts the assistant
 * usage records folded in — it gates the optional PromptResponse.usage field
 * (omitted when no usage data was collected, e.g. a cancel before the first
 * message).
 */
type TurnUsage = {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	reasoning: number
	/** Sum of the provider-computed usage.totalTokens across the chain. */
	total: number
	/** true once any provider actually reported a reasoning/thought count. */
	sawReasoning: boolean
	messages: number
}

function emptyTurnUsage(): TurnUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		total: 0,
		sawReasoning: false,
		messages: 0,
	}
}

type TurnContext = {
	cancelled: boolean
	hiddenToolCallIds: Set<string>
	announcedToolCallIds: Set<string>
	lastStreamedContent: Map<string, string>
	/**
	 * Pre-write file contents read at tool_execution_start for `write` tool
	 * calls: the original file content if the file existed (later surfaced as
	 * the diff's oldText), null for a new file. Keyed by toolCallId; the entry
	 * is consumed and cleared at tool_execution_end. Args travel only on
	 * tool_execution_start (ToolExecutionEndEvent carries none), so everything
	 * the end event needs must be captured here.
	 */
	preWriteContents: Map<string, string | null>
	/**
	 * File changes derived from tool args at tool_execution_start for the
	 * mutation tools (edit, write). Emitted as ACP `diff` content blocks at
	 * tool_execution_end; key removed once consumed. Read-only tools never
	 * appear here. Write entries keep their operation undecided until the end
	 * event resolves add-vs-modify from preWriteContents.
	 */
	pendingFileChanges: Map<string, PendingFileChange[]>
	usage: TurnUsage
	resolve: (res: PromptResponse) => void
	reject: (err: unknown) => void
}

/**
 * Internal file-mutation abstraction shared by the v1 and (future) v2 ACP
 * diff adapters. Populated from tool args at tool_execution_start so the v1
 * emission ({@link fileChangeToDiffContent}) is a pure adapter over data
 * already known before the tool ran — v2 migration is a pure adapter swap.
 */
export interface FileChange {
	path: string
	operation: "add" | "modify" | "delete"
	/** undefined for "add" */
	oldText?: string
	/** undefined for "delete" */
	newText?: string
}

/**
 * Captured-at-start representation of a pending diff. Edit calls resolve to
 * FileChange immediately (args carry both texts). Write calls carry the
 * "write" sentinel: whether the change is an add or a modify depends on
 * TurnContext.preWriteContents, which is only consulted at tool_execution_end
 * ({@link resolveFileChange}) — that is what keeps preWriteContents the
 * single source of truth for the write oldText.
 */
type PendingFileChange = FileChange | { operation: "write"; path: string; newText: string }

type SessionRecord = {
	session: AgentSession
	unsubscribe: () => void
	// Session cwd, captured at newSession/loadSession time. AgentSession keeps
	// its cwd private, but the ACP server needs it to resolve relative tool
	// paths (pre-write reads for per-turn diffs).
	cwd: string
	turn?: TurnContext
	/**
	 * Session-wide monotonic counter for ACP messageIds. Every distinct
	 * content block (text or thinking) across every assistant message in
	 * the session gets a fresh value — so two turns whose first text block
	 * both sit at contentIndex=0 still get distinct ids, satisfying the
	 * ACP contract "a change in messageId indicates a new message has
	 * started" without depending on contentIndex (which resets per turn).
	 * Seeded from the branch on loadSession so replay emits matching ids.
	 */
	nextBlockId: number
	/**
	 * Per-assistant-message map from pi-mono's contentIndex → assigned
	 * messageId. Cleared on each agent_start/message_start so a new assistant message
	 * starts a fresh contentIndex namespace without colliding with the
	 * previous message's assignments.
	 */
	contentIndexToBlockId: Map<number, string>
	/**
	 * Session-wide monotonic counter for ACP toolCallIds.
	 *
	 * toolCall.id comes straight from the model provider and carries no
	 * uniqueness guarantee beyond a single request — nothing in pi renumbers it,
	 * and providers do recycle ids. The ACP surface therefore rewrites every call
	 * to a fresh id so it satisfies the ACP contract "Unique identifier for a
	 * tool call within a session."
	 *
	 * This counter is the only source of `kt.*` ids and it never decrements, so
	 * every id it hands out is distinct regardless of where it starts — it does
	 * not need seeding from the persisted branch on loadSession.
	 */
	nextToolCallId: number
	/**
	 * Maps the upstream pi-mono toolCallId to the ACP toolCallId for the call
	 * currently in flight. A new `tool_execution_start` always allocates a fresh
	 * ACP id, so collisions across compaction boundaries are disambiguated.
	 */
	toolCallIdMap: Map<string, string>
	/**
	 * Per-session skill commands advertised to the ACP client. Populated from
	 * the session cwd during newSession/loadSession so command names can be
	 * resolved and skill content injected when the user invokes one.
	 */
	skillCommands: Map<string, AcpSkillInfo>
	/**
	 * The plan currently being advertised via ACP `plan` sessionUpdates, if
	 * any. Only set while a ferment is driving structured plan progress —
	 * the execute path (plan approved without a ferment) deliberately emits
	 * nothing. `planId` is the ferment id, kept for ACP v2 (`plan_update`
	 * with `PlanItems`) readiness.
	 */
	activePlan?: ActivePlan
	/**
	 * Tracks ferment lifecycle events + ferment-scoped todo store changes and
	 * emits `plan` sessionUpdates for this session. Started after extensions
	 * are bound, stopped in disposeSessionRecord.
	 */
	planTracker?: AcpPlanTracker
}

/** Options for {@link KimchiAcpAgent.disposeSessionRecord}. */
interface DisposeSessionRecordOpts {
	alreadyUnsubscribed?: boolean
}

/** Options for {@link KimchiAcpAgent.retireToolCall}. */
interface RetireToolCallOpts {
	removeFromHidden?: boolean
}

export class KimchiAcpAgent implements Agent {
	private sessions = new Map<string, SessionRecord>()
	private readonly sessionFactory: AcpSessionFactory
	private readonly agentDir: string
	private readonly sessionLister: AcpSessionLister
	private readonly sessionLoader: AcpSessionLoader
	private readonly mcpServerManager: McpServerManager | undefined
	private readonly permissionsEnvFlag = process.env[PERMISSIONS_ENV_KEY]
	private clientCapabilities: ClientCapabilities | undefined
	// Track non-text prompt block types we've already warned about so a
	// misbehaving client that sends 1000 image blocks doesn't flood stderr.
	private warnedBlockTypes = new Set<string>()
	// In-flight loadSession calls, keyed by session id. Without this, two
	// concurrent loads of the same id both pass the `sessions.has()` guard, open
	// the JSONL twice, and the later registration overwrites (and leaks) the
	// earlier session record.
	private loadingSessions = new Map<string, Promise<LoadSessionResponse>>()
	private shutdownPromise: Promise<void> | undefined

	/**
	 * Resolve the initial permission mode for a session.
	 */
	private getInitialPermissionMode(session: AgentSession): PermissionModeState {
		const cwd = session.sessionManager.getCwd()
		const { loaded } = loadConfig({ cwd })
		return resolveInitialPermissionMode(
			session.sessionManager,
			this.permissionsEnvFlag,
			resolveCliPermissionMode(),
			loaded,
		)
	}

	constructor(
		private readonly conn: AgentSideConnection,
		options: RunAcpOptions,
	) {
		this.sessionFactory = options.sessionFactory ?? defaultSessionFactory(options)
		this.agentDir = options.agentDir
		this.sessionLister = options.sessionLister ?? defaultSessionLister(options)
		this.sessionLoader = options.sessionLoader ?? defaultSessionLoader(options)
		this.mcpServerManager = options.mcpServerManager
	}

	async initialize(request: InitializeRequest): Promise<InitializeResponse> {
		setAcpClientInfo(request.clientInfo ?? { name: "unknown", version: "0.0.0" })

		this.clientCapabilities = request.clientCapabilities

		const modelRuntime = await ModelRuntime.create({
			authPath: join(this.agentDir, "auth.json"),
			modelsPath: join(this.agentDir, "models.json"),
		})
		const modelRegistry = new ModelRegistry(modelRuntime)
		const supportsImages = modelRegistry.getAvailable().some((m) => m.input?.includes("image"))

		// ACP Registry compliance: advertise at least one auth method. Agent Auth
		// (browser-based OAuth via local callback server) is always declared.
		// Terminal Auth (interactive `kimchi login`) is declared only when the
		// client advertises the terminal capability, per the auth-methods RFD:
		// "An Agent may advertise a terminal authentication method only when the
		// Client advertised the corresponding capability."
		const authMethods: AuthMethod[] = [
			{
				id: KIMCHI_AGENT_AUTH_METHOD_ID,
				name: "Kimchi Login",
				description: "Authenticate via browser to Kimchi",
			},
		]
		if (request.clientCapabilities?.auth?.terminal === true) {
			authMethods.push({
				id: "kimchi-terminal",
				name: "Log in from terminal",
				description: "Run Kimchi's interactive login flow",
				type: "terminal",
				args: ["login"],
			})
		}

		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: {
				name: "kimchi",
				version: getVersion(),
			},
			agentCapabilities: {
				loadSession: true,
				// Advertise logout support so clients know they can call
				// `unstable_logout` to clear stored credentials.
				auth: { logout: {} },
				// `list: {}` advertises support for session/list per spec
				// (SessionListCapabilities is `{ _meta? }` — empty object means
				// "supported"). loadSession remains the top-level flag because
				// the spec hasn't unified it under sessionCapabilities yet.
				sessionCapabilities: { list: {}, close: {} },
				promptCapabilities: { image: supportsImages, audio: false, embeddedContext: false },
				// Extended capabilities
				_meta: {
					[CAPABILITIES_KEY]: {
						...ADVERTISED_CAPABILITIES,
						...(this.mcpServerManager ? {} : { probe_mcp_server: false }),
					},
				},
			},
			authMethods,
		}
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		// Cursor pagination is out of scope for v1: pi reads only JSONL headers,
		// so even four-digit session counts comfortably meet the 500ms NFR
		// (revisit only if real installs hit slowness). `additionalDirectories`
		// (@experimental) is honored when non-empty by the default lister.
		const piSessions = await this.sessionLister(params)
		// Dedupe by session id: the default lister merges results from multiple
		// roots (cwd + additionalDirectories), and the same session can surface
		// twice when a client passes its cwd as one of the additional roots.
		// Keep first occurrence so cwd-listed entries win.
		const seen = new Set<string>()
		const sessions: ReturnType<typeof toAcpSessionInfo>[] = []
		for (const s of piSessions) {
			if (seen.has(s.id)) continue
			seen.add(s.id)
			// Skip subagent sessions: pi marks forked sessions with parentSessionPath
			// so delegated Agent runs don't clutter the user's session list.
			if (s.parentSessionPath) continue
			sessions.push(toAcpSessionInfo(s))
		}
		// Sort newest-first by updatedAt so Zed's picker surfaces recent threads
		// at the top without client-side sorting.
		sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
		// Explicit `nextCursor: null` signals end-of-pagination per the v1 spec
		// so clients don't infer it from an omitted field.
		return { sessions, nextCursor: null }
	}

	async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
		// Only the Agent Auth method ("kimchi-agent") is handled here. Terminal
		// Auth ("kimchi-terminal") is resolved out-of-band: the client launches
		// `kimchi login` as a separate process, so this method is never called
		// for it.
		if (params.methodId !== "kimchi-agent") {
			throw RequestError.invalidParams(undefined, `unknown auth method: ${params.methodId}`)
		}

		// Run the browser OAuth flow: starts a local callback server, opens the
		// user's browser to the Kimchi web app, and awaits the resulting token.
		let token: string
		try {
			;({ token } = await authenticateViaBrowser())
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			throw RequestError.internalError(undefined, `Browser authentication failed: ${detail}`)
		}
		if (!token) {
			throw RequestError.internalError(undefined, "Browser authentication did not return a token")
		}

		// Persist the key so new sessions pick it up via the login extension's
		// session_start handler (which reads loadConfig().apiKey).
		writeApiKey(token)

		// Eagerly refresh the model cache so the subsequent newSession() call
		// finds available models without another round-trip.
		await updateModelsConfig(join(this.agentDir, "models.json"), token)

		return {}
	}

	async unstable_logout(_params: LogoutRequest): Promise<LogoutResponse> {
		// Clear the persisted API key from config (loadConfig().apiKey), so
		// new sessions no longer pick it up via the login extension.
		clearApiKey()

		// Clear stored OAuth credentials (refresh tokens etc.) for the
		// kimchi-dev provider from auth.json.
		const modelRuntime = await ModelRuntime.create({
			authPath: join(this.agentDir, "auth.json"),
			modelsPath: join(this.agentDir, "models.json"),
			refreshOnCreate: false,
		})
		await modelRuntime.logout(KIMCHI_PROVIDER_ID)

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
		const initialMode = this.getInitialPermissionMode(session)
		// Once the factory hands us a live session we own its lifecycle. If model
		// verification, extension binding, subscribe, or the registering Map.set
		// throws before we hand it back to the caller, nothing else will ever
		// dispose it — so make ownership transfer atomic.
		try {
			assertSessionHasModel(session)

			const sessionId = session.sessionId
			const uiContext = this.createUiContext(session)
			registerPermissionFlagController(session, initialMode, (params) => this.send(params))
			// Build the record early so the ACP prompter can allocate ACP
			// toolCallIds that match the ids later emitted by tool_execution_start.
			// The unsubscribe placeholder is replaced after bindAcpExtensions so no
			// extension events are dropped before this.sessions is populated.
			const record: SessionRecord = {
				session,
				unsubscribe: () => {},
				cwd: session.sessionManager.getCwd(),
				nextBlockId: 0,
				contentIndexToBlockId: new Map(),
				nextToolCallId: 0,
				toolCallIdMap: new Map(),
				skillCommands: new Map(discoverAcpSkillCommands(session.resourceLoader).map((s) => [s.name, s])),
			}
			registerAcpPrompter(
				sessionId,
				createAcpPermissionPrompter(this.conn, sessionId, uiContext, (piToolCallId, toolName) =>
					this.getOrAllocateAcpToolCallId(record, piToolCallId, toolName),
				),
			)
			await this.bindAcpExtensions(session, uiContext)

			record.unsubscribe = session.subscribe((event) => this.onSessionEvent(sessionId, event))
			this.sessions.set(sessionId, record)
			this.startPlanTracker(record, sessionId)

			this.sendAvailableCommandsUpdate(sessionId)

			const configOptions = buildConfigOptions(session, () => this.getInitialPermissionMode(session).mode)
			return {
				sessionId,
				configOptions,
				models: buildSessionModelState(configOptions),
			}
		} catch (err) {
			unregisterAcpPrompter(session.sessionId)
			unregisterSessionPermissionFlagController(session.sessionId)
			clearPermissionModeEnv(session.sessionId)

			session.dispose()
			throw err
		}
	}

	private createUiContext(session: AgentSession): ExtensionUIContext {
		// Build the ExtensionUIContext that pi's runner routes `ctx.ui.*` calls
		// through. Bound to a single session for its lifetime — the connection,
		// capabilities, and `send` callback are all session-scoped state.
		return createAcpUIContext(this.conn, session.sessionId, this.clientCapabilities, (params) => this.send(params))
	}

	private async bindAcpExtensions(session: AgentSession, uiContext: ExtensionUIContext): Promise<void> {
		await session.bindExtensions({
			uiContext,
			// Mode is "rpc" so extensions can branch on `ctx.mode === "rpc"` to detect
			// this transport (added in pi-coding-agent 0.78.1). `ctx.hasUI` is derived
			// from the uiContext by the runner, so extensions that only check the
			// legacy boolean keep working too.
			mode: "rpc",
			onError: (err) => {
				process.stderr.write(`acp ext error [${err.extensionPath}] ${err.event}: ${err.error}\n`)
			},
		})

		// Activate the Skill tool if the claude-code-skills extension registered it.
		// This gives ACP sessions the same model-driven skill loading that TUI has
		// by default (skills === true).
		if (session.getToolDefinition("Skill")) {
			const active = new Set(session.getActiveToolNames())
			if (!active.has("Skill")) {
				session.setActiveToolsByName([...active, "Skill"])
			}
		}
	}

	/**
	 * Start emitting ACP `plan` sessionUpdates driven by the ferment
	 * lifecycle. The tracker subscribes to FERMENT_EVENTS.PHASE_STARTED on the
	 * same pi.events bus the ferment todo-sync bridge uses (exposed via
	 * defaultFermentRuntime.events after bindExtensions), and to the process-
	 * level todo store. Sessions without a running ferment never emit a plan.
	 * Called after the record is registered so a tracker start failure can't
	 * leave a half-registered session.
	 */
	private startPlanTracker(record: SessionRecord, sessionId: string): void {
		const tracker = new AcpPlanTracker({
			sessionId,
			events: defaultFermentRuntime.events,
			send: (params) => this.send(params),
			onActivePlanChanged: (plan) => {
				record.activePlan = plan
			},
		})
		tracker.start()
		record.planTracker = tracker
	}

	async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
		const record = this.sessions.get(params.sessionId)
		if (!record) {
			throw RequestError.invalidParams(undefined, `unknown sessionId ${params.sessionId}`)
		}
		await this.doSetModel(record, params.modelId)
		return {}
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		const record = this.sessions.get(params.sessionId)
		if (!record) {
			throw RequestError.invalidParams(undefined, `unknown sessionId ${params.sessionId}`)
		}
		switch (params.configId) {
			case "permissions-mode": {
				this.doSetPermissionMode(record, params.value ? `${params.value}` : "")
				break
			}
			case "model": {
				await this.doSetModel(record, params.value ? `${params.value}` : "")
				break
			}
			default:
				throw RequestError.invalidParams(undefined, `unknown config option ${params.configId}`)
		}
		return {
			configOptions: buildConfigOptions(record.session, () => this.getInitialPermissionMode(record.session).mode),
		}
	}

	private doSetPermissionMode(record: SessionRecord, mode: string): PermissionMode {
		const permissionMode = mode as PermissionMode
		if (!PERMISSION_MODES.includes(permissionMode)) {
			throw RequestError.invalidParams(undefined, `invalid mode ${permissionMode}`)
		}
		const sessionId = record.session.sessionId
		const { sessionManager } = record.session
		const state: PermissionModeState = { mode: permissionMode, initiatedBy: "user", source: "runtime" }
		persistPermissionModeIfChanged(sessionManager, (...args) => sessionManager.appendCustomEntry(...args), state)
		setPermissionMode(sessionId, state)
		return permissionMode
	}

	private async doSetModel(record: SessionRecord, value: string): Promise<string> {
		if (record.turn) {
			throw RequestError.invalidRequest(undefined, "a prompt is already in progress for this session")
		}
		if (!value) {
			throw RequestError.invalidParams(undefined, "modelId is required")
		}
		const { session } = record
		const sessionId = session.sessionId
		const modelRegistry = getSessionModelRegistry(session)
		if (value === "multi-model") {
			const { model: orchestrator, modelRef: orchRef } = getOrchestratorModel(session.sessionId, modelRegistry)
			if (!orchestrator) {
				throw RequestError.invalidParams(undefined, `multi-model orchestrator (${orchRef}) is not available`)
			}
			const previousMultiModelEnabled = getMultiModelEnabled(session.sessionManager)
			setMultiModelEnabled(sessionId, true)
			try {
				await session.setModel(orchestrator)
			} catch {
				setMultiModelEnabled(sessionId, previousMultiModelEnabled)
				// Pi's setModel only throws "if no auth is configured for the model"
				throw RequestError.authRequired(undefined, `orchestrator model ${orchRef} is not available: auth required`)
			}
			return value
		}

		const { provider, modelId } = splitModelRef(value) || {}
		if (!provider || !modelId) {
			throw RequestError.invalidParams(
				undefined,
				`invalid model format: "${value}". expected "provider/modelId" or "multi-model".`,
			)
		}
		const target = modelRegistry.find(provider, modelId)
		if (!target) {
			const available = modelRegistry
				.getAvailable()
				.map((m) => refFromModel(m))
				.sort()
			throw RequestError.invalidParams(
				undefined,
				`model not found: "${value}". available models: multi-model, ${available.join(", ")}`,
			)
		}

		const previousMultiModelEnabled = getMultiModelEnabled(session.sessionManager)
		setMultiModelEnabled(sessionId, false)
		try {
			await session.setModel(target)
		} catch {
			setMultiModelEnabled(sessionId, previousMultiModelEnabled)
			// Pi's setModel only throws "if no auth is configured for the model"
			throw RequestError.authRequired(undefined, `model ${refFromModel(target)} is not available: auth required`)
		}
		return value
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
		const sessionId = params.sessionId
		const existing = this.sessions.get(sessionId)
		if (existing) {
			if (existing.turn) {
				throw RequestError.invalidRequest(undefined, `session ${sessionId} has a turn in progress; cancel it first`)
			}
			this.replayTranscript(existing.session)
			this.sendAvailableCommandsUpdate(sessionId)

			const configOptions = buildConfigOptions(
				existing.session,
				() => this.getInitialPermissionMode(existing.session).mode,
			)
			return {
				configOptions,
				models: buildSessionModelState(configOptions),
			}
		}
		const loading = this.loadingSessions.get(sessionId)
		if (loading) return loading

		const loadingPromise = this.loadSessionFresh(params)
		this.loadingSessions.set(sessionId, loadingPromise)
		try {
			return await loadingPromise
		} finally {
			if (this.loadingSessions.get(sessionId) === loadingPromise) {
				this.loadingSessions.delete(sessionId)
			}
		}
	}

	private async loadSessionFresh(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		const session: AgentSession = await this.sessionLoader(params)
		const initialMode = this.getInitialPermissionMode(session)
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
			assertSessionHasModel(session)

			const uiContext = this.createUiContext(session)
			registerPermissionFlagController(session, initialMode, (params) => this.send(params))
			// Build the record early so the ACP prompter can allocate ACP
			// toolCallIds that match the ids later emitted by tool_execution_start.
			// The unsubscribe placeholder is replaced after bindAcpExtensions so no
			// extension events are dropped before this.sessions is populated.
			const record: SessionRecord = {
				session,
				unsubscribe: () => {},
				// The session header cwd was validated against params.cwd above, so
				// the session manager's cwd is the session's true cwd.
				cwd: session.sessionManager.getCwd(),
				nextBlockId: 0,
				contentIndexToBlockId: new Map(),
				nextToolCallId: 0,
				toolCallIdMap: new Map(),
				skillCommands: new Map(discoverAcpSkillCommands(session.resourceLoader).map((s) => [s.name, s])),
			}
			registerAcpPrompter(
				sid,
				createAcpPermissionPrompter(this.conn, sid, uiContext, (piToolCallId, toolName) =>
					this.getOrAllocateAcpToolCallId(record, piToolCallId, toolName),
				),
			)
			await this.bindAcpExtensions(session, uiContext)

			record.unsubscribe = session.subscribe((event) => this.onSessionEvent(sid, event))
			this.sessions.set(sid, record)
			this.startPlanTracker(record, sid)
			// A resumed session mid-ferment never re-fires PHASE_STARTED for the
			// already-active phase, so the tracker also snapshots from the
			// restored todo store (gated on an active ferment — emits nothing
			// when there is none or only global-scope todos survived).
			record.planTracker?.emitRestoredSnapshot()

			// Seed the block counter from the persisted branch so replay emits the
			// same messageIds the live turn would have — and so any new block the
			// user creates after the load gets a fresh, non-colliding id.
			this.seedBlockCounterFromBranch(session, record)

			// Replay BEFORE the response resolves so client sees a coherent transcript
			// when the loadSession promise settles. No turn context is created, so a
			// concurrent session/cancel during replay is a no-op — a turn must not
			// be considered active during replay.
			this.replayTranscript(session)
			this.sendAvailableCommandsUpdate(sid)

			const configOptions = buildConfigOptions(session, () => this.getInitialPermissionMode(session).mode)
			return {
				configOptions,
				models: buildSessionModelState(configOptions),
			}
		} catch (err) {
			unregisterAcpPrompter(sid)
			unregisterSessionPermissionFlagController(sid)
			clearPermissionModeEnv(sid)

			const existing = this.sessions.get(sid)
			if (existing) {
				this.sessions.delete(sid)
				existing.planTracker?.stop()
				existing.unsubscribe()
			}
			session.dispose()
			throw err
		}
	}

	async unstable_closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		await this.closeSessionRecord(params.sessionId)
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
		let text = params.prompt
			.map((b: ContentBlock) => (b.type === "text" ? b.text : ""))
			.join("")
			.trim()

		// If the prompt starts with `/skill:<name>` and matches a skill advertised
		// for this session, rewrite the turn to inject the skill content.
		const skillRewrite = await tryParseSkillCommand(text, entry.skillCommands)
		if (skillRewrite) {
			text = buildSkillCommandPrompt(skillRewrite)
		}

		// Extract image blocks from the prompt only if model supports vision.
		const images: ImageContent[] = supportsImages ? extractImages(params.prompt) : []
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
			announcedToolCallIds: new Set(),
			lastStreamedContent: new Map(),
			preWriteContents: new Map(),
			pendingFileChanges: new Map(),
			usage: emptyTurnUsage(),
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
				// session.prompt() is the source of truth for "turn is done". We
				// deliberately do NOT finalize on agent_end: pi-mono's _runAgentPrompt
				// (agent-session.js) chains multiple agent.prompt / agent.continue
				// calls — each emits its own agent_start + agent_end — when retries,
				// queued follow-up messages, or compaction are pending. If we finalized
				// on the first agent_end, end_turn would be sent mid-stream and the
				// client's subsequent prompt would hit pi-mono's
				// "Agent is already processing" throw because session.prompt is still
				// running the chained continues. session.prompt() resolves only after
				// ALL chained calls complete.
				if (entry.turn) {
					this.finalizeTurn(entry, entry.turn.cancelled ? "cancelled" : "end_turn")
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
		// Drain the steer/follow-up queue BEFORE awaiting the abort. pi-mono
		// chains queued steering messages into the running prompt —
		// session.prompt() resolves only after all chained calls — so awaiting
		// abort() first lets every still-queued steer self-deliver into history
		// with a full reply while we wait for idle. clearQueue() is synchronous,
		// so running it first drops undelivered steers before the chain can
		// drain them. Mirrors the TUI's Escape → clearAllQueues() behaviour.
		// The drain is wrapped in try/catch/finally so a clearQueue() failure
		// can never skip the abort — the turn is already marked cancelled, and
		// leaving the agent running would burn tokens until the LLM responds.
		// cancel() is a notification (fire-and-forget), so the error is caught
		// and logged rather than rethrown as an unhandled rejection; the worst
		// case is a partially-drained queue, which is no worse than before the
		// fix.
		try {
			entry.session.clearQueue()
		} catch (err) {
			// clearQueue failure is non-fatal — abort must still run. Log so a
			// recurring drain failure is observable instead of silently leaking
			// queued steers into history again.
			console.error("kimchi acp: clearQueue() failed during cancel; aborting anyway", err)
		} finally {
			await entry.session.abort()
		}
	}

	async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		switch (method) {
			case AVAILABLE_EXT_METHODS.probe_mcp_server: {
				const result = await handleProbeMcpServer(this.mcpServerManager, params)
				return result as Record<keyof ProbeResult, unknown>
			}
			case AVAILABLE_EXT_METHODS.set_session_title:
				return handleSetSessionTitle((sessionId) => this.sessions.get(sessionId)?.session, params)
			case AVAILABLE_EXT_METHODS.steering:
				return handleSteering((sessionId) => {
					const entry = this.sessions.get(sessionId)
					if (!entry) return undefined
					// A cancelled turn stays defined until the prompt settles, but
					// cancel() has already drained its queue — a steer landing in this
					// window must not re-queue text that would leak into the next prompt.
					const turnActive = entry.turn !== undefined && !entry.turn.cancelled
					return { session: entry.session, turnActive }
				}, params)
			default:
				throw RequestError.methodNotFound(method)
		}
	}

	async shutdown(cause: "signal" | "disconnect" = "disconnect"): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise
		this.shutdownPromise = this.doShutdown(cause)
		return this.shutdownPromise
	}

	private async doShutdown(_cause: "signal" | "disconnect"): Promise<void> {
		// Drain any in-flight turn promises before tearing down the session.
		// On the signal path we process.exit immediately so this is mostly
		// cosmetic, but runAcpMode's finally also calls shutdown when conn.closed
		// resolves — in that window a pending PromptResponse would otherwise hang
		// until process exit. Reject symmetrically so the caller's await settles.
		for (const entry of this.sessions.values()) {
			if (entry.turn) this.failTurn(entry, new Error("acp agent shutting down"))
			unregisterAcpPrompter(entry.session.sessionId)
			unregisterSessionPermissionFlagController(entry.session.sessionId)
			clearPermissionModeEnv(entry.session.sessionId)
			await this.disposeSessionRecord(entry)
		}
		this.sessions.clear()
		resetAcpClientInfo()
	}

	private async closeSessionRecord(sessionId: string): Promise<void> {
		const entry = this.sessions.get(sessionId)
		if (!entry) return
		this.sessions.delete(sessionId)
		unregisterAcpPrompter(sessionId)
		unregisterSessionPermissionFlagController(sessionId)
		clearPermissionModeEnv(sessionId)
		entry.unsubscribe()
		if (entry.turn) {
			entry.turn.cancelled = true
			try {
				await entry.session.abort()
			} catch {
				// Closing is best-effort cleanup; still resolve the pending prompt
				// as cancelled and release the session resources below.
			}
			this.finalizeTurn(entry, "cancelled")
		}
		await this.disposeSessionRecord(entry, { alreadyUnsubscribed: true })
	}

	private async disposeSessionRecord(entry: SessionRecord, opts: DisposeSessionRecordOpts = {}): Promise<void> {
		entry.planTracker?.stop()
		if (!opts.alreadyUnsubscribed) entry.unsubscribe()
		// Emit session_shutdown to extensions and await all handlers before
		// calling dispose(). dispose() is synchronous and returns void, so async
		// extension handlers (e.g. telemetry drain, shutdown marker) would be
		// fire-and-forgotten if we relied on dispose() alone.
		await entry.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
		entry.session.dispose()
	}

	private onSessionEvent(sessionId: string, event: AgentSessionEvent): void {
		const entry = this.sessions.get(sessionId)
		if (!entry) return
		const turn = entry.turn
		switch (event.type) {
			case "agent_start": {
				// New turn → contentIndex restarts from 0 and any in-flight tool
				// id mappings from the previous turn are stale (the calls either
				// ended or were orphaned). Wipe both maps so fresh allocations
				// don't reuse old ids.
				entry.contentIndexToBlockId.clear()
				entry.toolCallIdMap.clear()
				return
			}
			case "message_start": {
				// New assistant message → contentIndex restarts from 0. Wipe the
				// per-message map so a fresh block at index 0 gets a fresh id
				// instead of inheriting the previous message's assignment.
				entry.contentIndexToBlockId.clear()
				return
			}
			case "message_update": {
				if (!turn) return
				const ame = event.assistantMessageEvent
				if ((ame.type === "text_delta" || ame.type === "thinking_delta") && ame.delta) {
					let messageId = entry.contentIndexToBlockId.get(ame.contentIndex)
					if (messageId === undefined) {
						messageId = `km.${entry.nextBlockId++}`
						entry.contentIndexToBlockId.set(ame.contentIndex, messageId)
					}
					this.send({
						sessionId,
						update: {
							sessionUpdate: ame.type === "text_delta" ? "agent_message_chunk" : "agent_thought_chunk",
							content: { type: "text", text: ame.delta },
							messageId,
						},
					})
				}

				// Tool call argument generation started — emit pending tool_call so
				// the client can show progress while the model streams the arguments.
				if (ame.type === "toolcall_start") {
					const block = ame.partial?.content?.[ame.contentIndex]
					if (block?.type === "toolCall" && block.id && block.name) {
						if (isHiddenToolCall(block.name, block.arguments)) {
							turn.hiddenToolCallIds.add(block.id)
							return
						}
						const update: SessionUpdate = buildToolCall({
							toolName: block.name,
							toolCallId: this.getOrAllocateAcpToolCallId(entry, block.id, block.name),
							piToolCallId: block.id,
							rawInput: block.arguments,
							// Arguments are still streaming: the call hasn't been approved or started
							// executing yet, so ACP status is `pending`, not `in_progress`.
							status: "pending",
						})
						this.send({ sessionId, update })
						turn.announcedToolCallIds.add(block.id)
					}
					return
				}

				// Progress streaming — emit the incremental content delta (just
				// the new characters) so the client can show a live preview without
				// re-sending the full arguments on every delta.
				if (ame.type === "toolcall_delta") {
					const block = ame.partial?.content?.[ame.contentIndex]
					if (
						block?.type === "toolCall" &&
						block.id &&
						turn.announcedToolCallIds.has(block.id) &&
						!turn.hiddenToolCallIds.has(block.id)
					) {
						const content = extractStreamContent(block.arguments)
						if (content) {
							const prev = turn.lastStreamedContent.get(block.id) ?? ""
							const delta = content.slice(prev.length)
							if (delta.length > 0) {
								turn.lastStreamedContent.set(block.id, content)
								const update: SessionUpdate = buildToolCallUpdate({
									toolCallId: this.getOrAllocateAcpToolCallId(entry, block.id, block.name),
									piToolCallId: block.id,
									rawOutput: { delta },
									_meta: { generatedChars: content.length },
									// Arguments are still streaming: the call hasn't been approved or started
									// executing yet, so ACP status is `pending`, not `in_progress`.
									status: "pending",
								})
								this.send({ sessionId, update })
							}
						}
					}
					return
				}

				return
			}
			case "message_end": {
				if (!turn) return
				const msg = event.message
				if (msg.role !== "assistant") return
				const usage = msg.usage
				if (usage) {
					// `|| 0` guards against providers emitting undefined/NaN for a
					// field the type declares required — one bad message must not
					// poison the whole turn's totals.
					turn.usage.input += usage.input || 0
					turn.usage.output += usage.output || 0
					turn.usage.cacheRead += usage.cacheRead || 0
					turn.usage.cacheWrite += usage.cacheWrite || 0
					turn.usage.total += usage.totalTokens || 0
					// reasoning is a SUBSET of output (pi-ai 0.84 Usage docs) — summed
					// separately for thoughtTokens only, never re-added to totals.
					if (typeof usage.reasoning === "number" && Number.isFinite(usage.reasoning)) {
						turn.usage.reasoning += usage.reasoning
						turn.usage.sawReasoning = true
					}
					turn.usage.messages++
					// Live context-window refresh: a message_end carrying usage means
					// the session's estimate just moved. Emit here (subject to
					// emitUsageUpdate's undefined/null skip) so clients track the
					// context window across chained steps, not just at turn end.
					this.emitUsageUpdate(entry)
				}
				return
			}
			case "tool_execution_start": {
				// Symmetry with the other turn-lifecycle branches: if the turn was
				// already finalized (e.g., shutdown cleared it), don't emit stray
				// tool_call notifications the client would have to reconcile against
				// a turn it already considers over.
				if (!turn) return
				if (isHiddenToolCall(event.toolName, event.args)) {
					turn.hiddenToolCallIds.add(event.toolCallId)
					// A hidden call may already have an allocated ACP id if the permission
					// prompter ran before we knew it was hidden — retire its state.
					this.retireToolCall(entry, turn, event.toolCallId)
					return
				}
				// Capture the diff data now — tool_execution_end carries no args.
				// For `write` the pre-existing content must be read before the tool
				// runs; afterwards the file already holds the new content.
				const fileChanges = collectFileChanges(event.toolName, event.args, entry.cwd, turn, event.toolCallId)
				if (fileChanges.length > 0) {
					turn.pendingFileChanges.set(event.toolCallId, fileChanges)
				}
				const acpToolCallId = this.getOrAllocateAcpToolCallId(entry, event.toolCallId, event.toolName)
				if (turn.announcedToolCallIds.has(event.toolCallId)) {
					// Pending tool_call was already sent via toolcall_start → emit update
					const { title, kind, locations } = describeToolCall(event.toolName, event.args)
					const update: SessionUpdate = buildToolCallUpdate({
						toolCallId: acpToolCallId,
						piToolCallId: event.toolCallId,
						title,
						kind,
						locations,
						rawInput: event.args,
						status: "in_progress",
					})
					this.send({ sessionId, update })
				} else {
					const update: SessionUpdate = buildToolCall({
						toolCallId: acpToolCallId,
						piToolCallId: event.toolCallId,
						toolName: event.toolName,
						rawInput: event.args,
						status: "in_progress",
					})
					// No pending notification was sent (back-compat) → emit tool_call as before
					this.send({ sessionId, update })
				}
				return
			}
			case "tool_execution_update": {
				if (!turn) return
				if (turn.hiddenToolCallIds.has(event.toolCallId) || isHiddenToolCall(event.toolName, event.args)) {
					turn.hiddenToolCallIds.add(event.toolCallId)
					// A hidden call may already have an allocated ACP id if the permission
					// prompter ran before we knew it was hidden — retire its state.
					this.retireToolCall(entry, turn, event.toolCallId)
					return
				}
				const acpToolCallId = this.resolveAcpToolCallId(entry, event.toolCallId)
				const partial = toolResultContent(event.partialResult)
				if (partial.length === 0) return
				const update: SessionUpdate = buildToolCallUpdate({
					toolCallId: acpToolCallId,
					piToolCallId: event.toolCallId,
					content: partial,
					status: "in_progress",
				})
				this.send({ sessionId, update })
				return
			}
			case "tool_execution_end": {
				if (!turn) return
				if (turn.hiddenToolCallIds.has(event.toolCallId)) {
					this.retireToolCall(entry, turn, event.toolCallId, { removeFromHidden: true })
					return
				}
				// Consume the per-call capture so a later turn reusing the id (or a
				// retried call) can't leak stale diff data across tool calls.
				const pending = turn.pendingFileChanges.get(event.toolCallId) ?? []
				turn.pendingFileChanges.delete(event.toolCallId)
				const preWrite = turn.preWriteContents.get(event.toolCallId)
				turn.preWriteContents.delete(event.toolCallId)
				// Diffs are additional content blocks, appended after the existing
				// text/image content. Failed mutations emit no diff: the client
				// would otherwise render a change that never landed.
				const diffs = event.isError ? [] : pending.map((p) => fileChangeToDiffContent(resolveFileChange(p, preWrite)))
				const acpToolCallId = this.resolveAcpToolCallId(entry, event.toolCallId)
				const update: SessionUpdate = buildToolCallUpdate({
					toolCallId: acpToolCallId,
					piToolCallId: event.toolCallId,
					status: event.isError ? "failed" : "completed",
					content: [...toolResultContent(event.result), ...diffs],
					rawOutput: event.result,
				})
				this.send({ sessionId, update })
				// Upstream ids can repeat after compaction or even within a turn. Retire
				// all state keyed on this upstream id so a future call reusing it starts
				// with a fresh ACP id and clean streaming/announcement state.
				this.retireToolCall(entry, turn, event.toolCallId, { removeFromHidden: true })
				return
			}
			case "session_info_changed": {
				const name = event.name
				if (!name) return
				this.send({
					sessionId,
					update: {
						sessionUpdate: "session_info_update",
						title: name,
					},
				})
				return
			}
			default:
				return
		}
	}

	// Replay: walk the persisted transcript on the leaf path and emit
	// session/update notifications per content block — text, thinking, tool
	// calls. Tool results are paired with their originating toolCall by id so
	// the historical tool render shape (tool_call + terminal tool_call_update)
	// matches what live turns produce. Compaction / branch_summary /
	// model_change / custom entries emit nothing — using getBranch() (raw
	// entries) instead of buildSessionContext() avoids surfacing compaction
	// summaries as synthetic user messages.
	//
	// Notifications go straight from this method to conn.sessionUpdate; we do
	// NOT replay through the AgentSession event emitter, so extensions like
	// telemetryExtension don't double-count historical turns.
	private replayTranscript(session: AgentSession): void {
		const sessionId = session.sessionId
		const entries = session.sessionManager.getBranch()
		const toolResults = collectToolResults(entries)

		for (const entry of entries) {
			if (!entry || typeof entry !== "object" || entry.type !== "message") continue
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
				this.replayAssistantBlocks(sessionId, msg.content, toolResults, this.sessions.get(sessionId))
			}
			// toolResult: handled inline alongside its originating toolCall above.
		}
	}

	/**
	 * Walk the persisted branch and count how many ACP content chunks the
	 * replay would emit (text segments + dimmed text parts + non-redacted
	 * thinking blocks). Sets `record.nextBlockId` so that:
	 *   - replayTranscript emits the same messageIds a live turn would have
	 *     for the historical blocks, and
	 *   - any new block the user creates after the load gets a fresh, non-
	 *     colliding id.
	 *
	 * Mirrors replayAssistantBlocks' emission logic exactly — coalescing
	 * contiguous text blocks into one chunk, and gating thinking emission on
	 * the hideThinkingBlock setting. If these drift, messageIds replayed
	 * after a load won't line up with what the client saw during the live
	 * turn.
	 */
	private seedBlockCounterFromBranch(session: AgentSession, record: SessionRecord): void {
		const entries = session.sessionManager.getBranch()

		let count = 0
		for (const entry of entries) {
			if (entry?.type !== "message" || entry.message.role !== "assistant") continue

			let inTextSegment = false
			const countTextSegment = () => {
				if (!inTextSegment) {
					count++
					inTextSegment = true
				}
			}

			const content = entry.message.content
			for (const block of content) {
				if (block.type === "text") {
					if (!block.text) continue
					countTextSegment()
					for (const part of replayTextParts(block.text)) {
						if (part.kind === "thinking") count++
					}
				} else if (block.type === "thinking") {
					inTextSegment = false
					if (block.redacted || !block.thinking) continue
					count++
				} else {
					// toolCall / unknown: replay flushes the text buffer before
					// emitting the structural block, which terminates any open
					// text segment.
					inTextSegment = false
				}
			}
		}
		record.nextBlockId = count + 1
	}

	private replayAssistantBlocks(
		sessionId: string,
		content: AssistantMessage["content"],
		toolResults: Map<string, ReplayToolResult>,
		record: SessionRecord | undefined,
	): void {
		if (!Array.isArray(content)) return
		// Allocates a fresh session-unique messageId for every emitted chunk
		// and leaves it off the wire if the SessionRecord isn't loaded (e.g.
		// the unit-test harness wiring a partial replay path).
		const nextMessageId = () => {
			if (!record) return undefined
			return `km.${record.nextBlockId++}`
		}
		// Buffer contiguous text blocks so a single assistant message renders as
		// one agent_message_chunk per natural text segment — emit the full
		// message as a single chunk, no per-token chunking. When a thinking or
		// toolCall block interrupts the run, flush the buffered text first so
		// ordering relative to those structural blocks is preserved.
		let textBuffer = ""
		const flushText = () => {
			if (textBuffer.length === 0) return
			const messageId = nextMessageId()
			this.send({
				sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: textBuffer },
					...(messageId !== undefined ? { messageId } : {}),
				},
			})
			textBuffer = ""
		}
		for (const block of content) {
			if (!block || typeof block !== "object") continue
			const b = block
			if (b.type === "text") {
				const text = (b as { text?: unknown }).text
				if (typeof text !== "string" || text.length === 0) continue
				for (const part of replayTextParts(text)) {
					if (part.kind === "text") {
						textBuffer += part.text
					} else if (part.kind === "thinking") {
						flushText()
						const messageId = nextMessageId()
						this.send({
							sessionId,
							update: {
								sessionUpdate: "agent_thought_chunk",
								content: { type: "text", text: part.text },
								...(messageId !== undefined ? { messageId } : {}),
							},
						})
					}
				}
			} else if (b.type === "thinking") {
				flushText()
				const thinking = (b as { thinking?: unknown; redacted?: unknown }).thinking
				const redacted = (b as { redacted?: unknown }).redacted === true
				// Redacted thinking has no plaintext to surface — the encrypted
				// payload only matters for multi-turn provider continuity.
				if (redacted || typeof thinking !== "string" || thinking.length === 0) continue
				const messageId = nextMessageId()
				this.send({
					sessionId,
					update: {
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: stripAnsi(thinking) },
						...(messageId !== undefined ? { messageId } : {}),
					},
				})
			} else if (b.type === "toolCall") {
				flushText()
				const tc = b
				const upstreamId = typeof tc.id === "string" ? tc.id : undefined
				const name = typeof tc.name === "string" ? tc.name : undefined
				if (!upstreamId || !name) continue
				const args = (tc.arguments ?? {}) as Record<string, unknown>
				if (isHiddenToolCall(name, args)) continue
				const acpToolCallId = record ? this.getOrAllocateAcpToolCallId(record, upstreamId, name) : upstreamId
				const result = toolResults.get(upstreamId)
				// No persisted result → the call never finished (interrupted mid
				// turn). "failed" is the closest terminal status; leaving the call
				// in_progress would hang the client's spinner forever on replay.
				const status: "completed" | "failed" = result ? (result.isError ? "failed" : "completed") : "failed"
				this.send({
					sessionId,
					update: buildToolCall({
						toolName: name,
						toolCallId: acpToolCallId,
						piToolCallId: tc.id,
						status,
						rawInput: args,
					}),
				})
				this.send({
					sessionId,
					update: buildToolCallUpdate({
						toolCallId: acpToolCallId,
						piToolCallId: tc.id,
						status,
						content: result ? toolResultContent(result) : [],
						rawOutput: result,
					}),
				})
				// The branch may contain multiple toolCalls with the same upstream id
				// (e.g., across a compaction boundary). Drop the mapping after replaying
				// each call so the next one with the same upstream id gets a fresh id.
				record?.toolCallIdMap.delete(upstreamId)
			}
		}
		// Trailing text after the last structural block (or a text-only message)
		// still needs to land — flushText is a no-op when the buffer is empty.
		flushText()
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

	/**
	 * Return the existing ACP toolCallId for an upstream id, allocating a fresh
	 * session-unique id if none exists. Permission prompts fire before
	 * `tool_execution_start`, so this ensures the permission request and the
	 * subsequent tool_call notification share the same id.
	 */
	private getOrAllocateAcpToolCallId(record: SessionRecord, piToolCallId: string, toolName: string): string {
		let acpId = record.toolCallIdMap.get(piToolCallId)
		if (acpId === undefined) {
			acpId = `kt.${toolName}.${record.nextToolCallId++}`
			record.toolCallIdMap.set(piToolCallId, acpId)
		}
		return acpId
	}

	/**
	 * Look up the ACP toolCallId for an in-flight upstream call. Falls back to
	 * the upstream id if no mapping exists (defensive: should only happen for
	 * events that arrived before their start, which pi-mono does not emit).
	 */
	private resolveAcpToolCallId(record: SessionRecord, piToolCallId: string): string {
		return record.toolCallIdMap.get(piToolCallId) ?? piToolCallId
	}

	/**
	 * Retire all per-call state keyed on an upstream toolCallId.
	 *
	 * Upstream ids are provider-supplied and can repeat within a turn (e.g. after
	 * compaction). Leaving stale entries in `announcedToolCallIds` or
	 * `lastStreamedContent` causes corrupted deltas or updates for ids the client
	 * never saw when the id is reused.
	 */
	private retireToolCall(
		record: SessionRecord,
		turn: TurnContext,
		piToolCallId: string,
		opts: RetireToolCallOpts = {},
	): void {
		record.toolCallIdMap.delete(piToolCallId)
		turn.announcedToolCallIds.delete(piToolCallId)
		turn.lastStreamedContent.delete(piToolCallId)
		if (opts.removeFromHidden) {
			turn.hiddenToolCallIds.delete(piToolCallId)
		}
	}

	private sendAvailableCommandsUpdate(sessionId: string): void {
		const record = this.sessions.get(sessionId)
		const skillCommands = record ? buildSkillAvailableCommands(Array.from(record.skillCommands.values())) : []
		this.send({
			sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: [...AVAILABLE_COMMANDS, ...skillCommands],
			},
		})
	}

	private emitUsageUpdate(entry: SessionRecord): void {
		const session = entry.session
		const ctx = session.getContextUsage()
		// Per the issue doc: skip when getContextUsage() returns undefined or
		// tokens is null (e.g. right after compaction). ACP requires both `used`
		// and `size`, so there is no null-safe emission.
		if (!ctx || ctx.tokens === null) return
		this.send({
			sessionId: session.sessionId,
			update: {
				sessionUpdate: "usage_update",
				used: ctx.tokens,
				size: ctx.contextWindow,
			},
		})
	}

	private finalizeTurn(entry: SessionRecord, stopReason: PromptResponse["stopReason"]): void {
		const turn = entry.turn
		if (!turn) return
		entry.turn = undefined
		try {
			this.emitUsageUpdate(entry)
		} finally {
			const response: PromptResponse = { stopReason }
			// usage is v1/experimental-only on PromptResponse (v2 drops it in favor
			// of usage_update session events) and is omitted when the turn produced
			// no usage data (e.g. cancelled before the first assistant message).
			// totalTokens is emitted because the pinned ACP SDK's experimental Usage
			// type marks it required, even though the ticket's v1 field table drops it.
			if (turn.usage.messages > 0) {
				const u = turn.usage
				response.usage = {
					inputTokens: u.input,
					outputTokens: u.output,
					cachedReadTokens: u.cacheRead,
					cachedWriteTokens: u.cacheWrite,
					...(u.sawReasoning ? { thoughtTokens: u.reasoning } : {}),
					totalTokens: u.total,
				}
			}
			turn.resolve(response)
		}
	}

	private failTurn(entry: SessionRecord, err: unknown): void {
		const turn = entry.turn
		if (!turn) return
		entry.turn = undefined
		turn.reject(err)
	}
}

/**
 * Builds a SessionConfigOption for the permissions mode setting.
 * Exposes the four permission modes (default, plan, auto, yolo) as a select
 * option that ACP clients can read and modify.
 * Exported for testing.
 */
export function buildPermissionsConfigOption(currentMode: PermissionMode): SessionConfigOption {
	return {
		id: "permissions-mode",
		name: "Permissions Mode",
		type: "select",
		category: "mode",
		description:
			"Control tool execution permissions: default (prompt for writes), plan (read-only), auto (classifier-gated), yolo (no restrictions)",
		currentValue: currentMode,
		options: PERMISSION_MODES_WITH_META.map(({ mode, label, description }) => ({
			name: label,
			value: mode,
			description,
		})),
	}
}

/**
 * Builds a SessionConfigOption for the model setting.
 * Combines the orchestrator model with multi-model support into a single select UI.
 * Exported for testing.
 */
type AgentSessionModelConfig = Pick<AgentSession, "model" | "modelRuntime" | "sessionId" | "sessionManager"> & {
	modelRegistry?: ModelRegistry
}

function getSessionModelRegistry(
	session: Pick<AgentSession, "modelRuntime"> & { modelRegistry?: ModelRegistry },
): ModelRegistry {
	return session.modelRegistry ?? new ModelRegistry(session.modelRuntime)
}

export function buildModelConfigOption(session: AgentSessionModelConfig): SessionConfigOption {
	const multiModelEnabled = getMultiModelEnabled(session.sessionManager)
	const modelRegistry = getSessionModelRegistry(session)
	const {
		model: orchestrator,
		modelRef: orchRef,
		modelId: orchId,
	} = getOrchestratorModel(session.sessionId, modelRegistry)
	const orchName = orchestrator?.name ?? orchId ?? orchRef
	const options = [
		{
			value: "multi-model",
			name: `Multi-model (${orchName})`,
		},
		...modelRegistry
			.getAvailable()
			.map((m) => ({
				value: refFromModel(m),
				name: m.name,
			}))
			.sort((a, b) => a.value.localeCompare(b.value)),
	]
	// biome-ignore lint/style/noNonNullAssertion: we assert model availability before session is created/loaded via assertSessionHasModel.
	const currentValue = multiModelEnabled ? "multi-model" : refFromModel(session.model!)
	return {
		id: "model",
		name: "Model",
		type: "select",
		category: "model",
		description: "Select the active AI model: single-model or multi-model (orchestrator + workers).",
		currentValue,
		options,
	}
}

function buildConfigOptions(
	session: AgentSession,
	defaultMode: PermissionMode | (() => PermissionMode),
): SessionConfigOption[] {
	const mode =
		getPermissionMode(session.sessionId)?.mode ?? (typeof defaultMode === "function" ? defaultMode() : defaultMode)
	return [buildPermissionsConfigOption(mode), buildModelConfigOption(session)]
}

export function buildSessionModelState(configOptions: SessionConfigOption[]): SessionModelState | null {
	// biome-ignore lint/style/noNonNullAssertion: model config option is static, it is always available
	const configOption = configOptions.find((opt) => opt.id === "model")!
	const options = (configOption as SessionConfigOption & { type: "select" }).options as SessionConfigSelectOption[]
	return {
		currentModelId: configOption.currentValue as string,
		availableModels: options.map((m) => ({
			modelId: m.value,
			name: m.name,
		})),
	}
}

export function assertSessionHasModel(session: Pick<AgentSession, "model">): void {
	if (!session.model) {
		throw RequestError.authRequired(
			undefined,
			"No model available for ACP session. Configure an API key or models.json first.",
		)
	}
}

export function initializeHeadlessTheme(settingsManager: Pick<SettingsManager, "getTheme">): void {
	initTheme(settingsManager.getTheme(), false)
}

function registerPermissionFlagController(
	session: AgentSession,
	initialMode: PermissionModeState,
	send: (params: SessionNotification) => void,
): void {
	const permissionFlagController = createSessionPermissionFlagController({
		mode: initialMode,
	})
	// Register with permissions extension so tool gating uses session-scoped mode
	registerSessionPermissionFlagController(session.sessionId, permissionFlagController)
	permissionFlagController.subscribe(({ mode }) => {
		if (mode === undefined) return
		send({
			sessionId: session.sessionId,
			update: {
				sessionUpdate: "config_option_update",
				configOptions: buildConfigOptions(session, initialMode.mode),
			},
		})
	})
}

const TITLE_MAX = 80

// Title falls back to the truncated first user message when the session has no
// user-defined name. ACP clients render this in the thread-picker UI; we do
// NOT trigger a fresh prompt-summary on listSessions because that would mean
// an LLM call per session and break the 500ms NFR.
export function toAcpSessionInfo(info: PiSessionInfo): AcpSessionInfo {
	// Use truthiness rather than `??` so an empty `name` (migration artifact or
	// hand-edited session-info entry) still falls through to firstMessage —
	// `??` only short-circuits on null/undefined and would otherwise leave the
	// title as the empty string and end up null below.
	const fallback = info.firstMessage ? truncate(info.firstMessage, TITLE_MAX) : ""
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

// Find the on-disk JSONL for a sessionId. pi names files
// `<isoTimestamp>_<sessionId>.jsonl` — match that suffix, with a fallback to
// the bare `<sessionId>.jsonl` form so a hypothetical future pi format change
// still resolves. That fallback is scoped to the already cwd-encoded directory
// and the loader validates the file header id/cwd before opening it; a hand-
// placed file must still match both to load. Returns null when the directory is
// missing or no file matches; rethrows other errno (EACCES, EMFILE, …) so the
// caller can surface them instead of masquerading as "session not found".
function resolveSessionPathById(sessionDir: string, sessionId: string): string | null {
	let entries: string[]
	try {
		entries = readdirSync(sessionDir)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
		throw err
	}
	const suffix = `_${sessionId}.jsonl`
	const bare = `${sessionId}.jsonl`
	const match = entries.find((f) => f === bare || f.endsWith(suffix))
	return match ? join(sessionDir, match) : null
}

const SESSION_HEADER_PEEK_BYTES = 8 * 1024

function parseSessionHeader(raw: string): Pick<SessionHeader, "id" | "cwd"> | null {
	for (const line of raw.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) continue
		let entry: unknown
		try {
			entry = JSON.parse(trimmed)
		} catch {
			continue
		}
		if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "session") continue
		const header = entry as { id?: unknown; cwd?: unknown }
		if (typeof header.id !== "string" || typeof header.cwd !== "string") return null
		return { id: header.id, cwd: header.cwd }
	}
	return null
}

function readSessionHeaderPeek(sessionPath: string): { raw: string; complete: boolean } {
	const fd = openSync(sessionPath, "r")
	try {
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_PEEK_BYTES)
		const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
		return {
			raw: buffer.toString("utf-8", 0, bytesRead),
			complete: bytesRead < SESSION_HEADER_PEEK_BYTES,
		}
	} finally {
		closeSync(fd)
	}
}

function readSessionHeader(sessionPath: string): Pick<SessionHeader, "id" | "cwd"> | null {
	const peek = readSessionHeaderPeek(sessionPath)
	const parseablePeek = peek.complete ? peek.raw : peek.raw.slice(0, Math.max(0, peek.raw.lastIndexOf("\n") + 1))
	const header = parseSessionHeader(parseablePeek)
	if (header || peek.complete) return header
	return parseSessionHeader(readFileSync(sessionPath, "utf-8"))
}

function defaultSessionLister(options: RunAcpOptions): AcpSessionLister {
	return async (params: ListSessionsRequest) => {
		// Build the set of roots to enumerate: cwd (when present) plus any
		// non-empty additionalDirectories. Dedupe to avoid double-listing when
		// a client sends cwd as one of the additional roots.
		const roots: string[] = []
		if (params.cwd) roots.push(params.cwd)
		for (const dir of params.additionalDirectories ?? []) {
			if (!roots.includes(dir)) roots.push(dir)
		}
		if (roots.length === 0) {
			// listAll has no agentDir slot in pi today, so a non-default agentDir
			// won't be honored for the unscoped path. Acceptable v1 limitation:
			// Zed's thread-import always supplies a cwd.
			return SessionManager.listAll()
		}
		const lists = await Promise.all(
			roots.map((root) => SessionManager.list(root, join(options.agentDir, "sessions", encodeCwdDir(root)))),
		)
		return lists.flat()
	}
}

/**
 * Shared session-setup: create settings manager, apply theme + HTTP idle
 * timeout, and load resources. Both the session loader and factory
 * diverge only in how they obtain a SessionManager.
 */
async function createSessionSettings(cwd: string, options: RunAcpOptions, params: { _meta?: unknown }) {
	// Construct untrusted first: pi's SettingsManager.create defaults
	// projectTrusted to TRUE, which would let an untrusted repo's
	// .pi/settings.json influence HTTP behavior (e.g. disable the idle
	// timeout) — and the defaultProjectTrust read below must be global-scope
	// only so a project cannot grant itself trust. Trust is then resolved the
	// way pi's own no-UI path does and applied in-memory.
	const settingsManager = SettingsManager.create(cwd, options.agentDir, { projectTrusted: false })
	settingsManager.setProjectTrusted(
		resolveHeadlessProjectTrust(cwd, options.agentDir, settingsManager.getDefaultProjectTrust()),
	)
	initializeHeadlessTheme(settingsManager)
	// Getter form: re-read on every request so mid-session settings edits
	// apply live. The override slot is process-global — with several ACP
	// sessions in one process, the last-configured session's value governs
	// all of them (see setStreamIdleTimeoutOverride).
	configureHttpIdleTimeout(() => settingsManager.getHttpIdleTimeoutMs())
	// Cache the skill list block per session so we don't rediscover skills on
	// every turn's system prompt rebuild. Built lazily on first access; errors
	// during loader access fall back to an empty block.
	let cachedSkillListBlock: string | undefined
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: options.agentDir,
		settingsManager,
		extensionFactories: options.extensionFactories,
		appendSystemPromptOverride: () => {
			if (cachedSkillListBlock === undefined) {
				try {
					cachedSkillListBlock = buildSkillListBlock(resourceLoader)
				} catch {
					// If the loader isn't ready (e.g. during reload before skills
					// are populated), return empty rather than crashing session
					// startup — the block is non-essential.
					cachedSkillListBlock = ""
				}
			}
			// CLI flag content first, then _meta["kimchi.dev"].appendSystemPrompt,
			// then the skill list block (matches upstream override behaviour).
			const base = resolveAcpAppendSystemPrompt(params, options) ?? []
			return [...base, ...(cachedSkillListBlock ? [cachedSkillListBlock] : [])]
		},
	})
	await resourceLoader.reload()
	return { settingsManager, resourceLoader }
}

/** Exported for tests: the production session loader used by {@link KimchiAcpAgent}. */
export function defaultSessionLoader(options: RunAcpOptions): AcpSessionLoader {
	return async (params: LoadSessionRequest): Promise<AgentSession> => {
		const cwd = params.cwd
		// Mirror defaultSessionLister: encode cwd inline because pi doesn't
		// re-export getDefaultSessionDir from its package index. Threading
		// agentDir explicitly is load-bearing — pi reads PI_CODING_AGENT_DIR,
		// not KIMCHI_CODING_AGENT_DIR, so default lookups would miss kimchi
		// sessions stored under the kimchi agent dir.
		const sessionDir = join(options.agentDir, "sessions", encodeCwdDir(cwd))
		// pi writes session files as `<isoTimestamp>_<sessionId>.jsonl` (see
		// SessionManager.setSessionFile auto-generation). Looking up by bare
		// `<sessionId>.jsonl` would miss every real session — match the
		// timestamp-prefixed form (and accept the bare form too as a forward-
		// compat hedge if pi ever drops the prefix). Scan the cwd-scoped dir
		// directly rather than calling SessionManager.list, which would parse
		// every JSONL header just to find one file.
		let sessionPath: string | null
		try {
			sessionPath = resolveSessionPathById(sessionDir, params.sessionId)
		} catch (err) {
			// EACCES / EMFILE / etc. — surface the underlying readdir error so
			// Zed can show something more useful than "session not found", but
			// still as invalidParams so it doesn't trip Zed's "server shut down
			// unexpectedly" error path.
			const msg = err instanceof Error ? err.message : String(err)
			throw RequestError.invalidParams(undefined, `failed to read session directory: ${msg}`)
		}
		// Map "session not found" to invalidParams — SessionManager.open would
		// silently start a fresh session on a missing file (and rewrite it with
		// a new id), which is destructive and not what loadSession should do.
		if (!sessionPath) {
			throw RequestError.invalidParams(undefined, `session ${params.sessionId} not found`)
		}
		let header: Pick<SessionHeader, "id" | "cwd"> | null
		try {
			header = readSessionHeader(sessionPath)
		} catch (err) {
			// Same invalidParams treatment as SessionManager.open below: the file
			// existed at resolve time but could not be read now (permissions,
			// post-readdir delete, etc.).
			const msg = err instanceof Error ? err.message : String(err)
			throw RequestError.invalidParams(undefined, `failed to read session header: ${msg}`)
		}
		if (!header) {
			throw RequestError.invalidParams(undefined, `session ${params.sessionId} has no valid session header`)
		}
		if (header.id !== params.sessionId) {
			throw RequestError.invalidParams(
				undefined,
				`session header id ${header.id} does not match requested sessionId ${params.sessionId}`,
			)
		}
		// Reject cwd mismatch before opening SessionManager. pi has no
		// close/dispose hook on SessionManager itself; peeking the header avoids
		// constructing a manager for a session this request is not allowed to
		// load.
		if (header.cwd !== cwd) {
			throw RequestError.invalidParams(undefined, `session cwd ${header.cwd} does not match requested cwd ${cwd}`)
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
			// errors (permissions, post-readdir delete) and migration
			// failures still propagate. Surface as invalidParams with a
			// one-line message instead of crashing the connection (which
			// triggers Zed's "server shut down unexpectedly" toast).
			const msg = err instanceof Error ? err.message : String(err)
			throw RequestError.invalidParams(undefined, `failed to open session: ${msg}`)
		}
		const { settingsManager, resourceLoader } = await createSessionSettings(cwd, options, params)
		const { session } = await createAgentSession({
			cwd,
			agentDir: options.agentDir,
			settingsManager,
			resourceLoader,
			sessionManager,
		})
		return session
	}
}

/** Exported for tests: the production session factory used by {@link KimchiAcpAgent}. */
export function defaultSessionFactory(options: RunAcpOptions): AcpSessionFactory {
	return async (params: NewSessionRequest): Promise<AgentSession> => {
		const cwd = params.cwd ?? process.cwd()
		const { settingsManager, resourceLoader } = await createSessionSettings(cwd, options, params)
		const { session } = await createAgentSession({
			cwd,
			agentDir: options.agentDir,
			settingsManager,
			resourceLoader,
		})
		return session
	}
}

// Persisted assistant text from hide-thinking-aware models (DeepSeek, QwQ, ...)
// can contain ANSI styling around inner <think> content. Live TUI styling means
// "this is reasoning"; ACP plaintext has no such styling, so replay splits the
// known thinking wrappers into agent_thought_chunk and strips remaining CSI
// escapes from ordinary text.
// Built from String.fromCharCode to keep the literal ESC byte out of source;
// biome's noControlCharactersInRegex flags it inside a regex literal.
const ANSI_ESC = String.fromCharCode(0x1b)
const ANSI_PATTERN = new RegExp(`${ANSI_ESC}\\[[0-9;]*[A-Za-z]`, "g")
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const ANSI_THINKING_OPEN_CODES = ["2", "38;2;102;102;102", "38;5;242"]
const ANSI_THINKING_PATTERN = new RegExp(
	`${ANSI_ESC}\\[(?:${ANSI_THINKING_OPEN_CODES.map(escapeRegExp).join("|")})m([\\s\\S]*?)(?:${ANSI_ESC}\\[(?:0|22)m|$)`,
	"g",
)
export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "")
}

type ReplayTextPart = { kind: "text" | "thinking"; text: string }

function replayTextParts(text: string): ReplayTextPart[] {
	const parts: ReplayTextPart[] = []
	let lastIndex = 0
	for (const match of text.matchAll(ANSI_THINKING_PATTERN)) {
		const index = match.index ?? 0
		const before = stripAnsi(text.slice(lastIndex, index))
		if (before.length > 0) parts.push({ kind: "text", text: before })
		const thinking = stripAnsi(match[1] ?? "")
		if (thinking.length > 0) parts.push({ kind: "thinking", text: thinking })
		lastIndex = index + match[0].length
	}
	const after = stripAnsi(text.slice(lastIndex))
	if (after.length > 0) parts.push({ kind: "text", text: after })
	return parts
}

/**
 * Extracts the main content string being streamed for common tool calls
 * (write.content, edit.newText, bash.command). Returns undefined if no
 * content field is recognized yet (model hasn't streamed that key).
 */
function extractStreamContent(args: unknown): string | undefined {
	const a = (args ?? {}) as Record<string, unknown>
	return asString(a.content) ?? asString(a.newText) ?? asString(a.command)
}

// ACP v1 Diff = { path, newText, oldText? }. The v1 adapter maps one
// FileChange to one ToolCallContent with type "diff": add carries
// oldText: null, modify carries both texts, delete omits newText (no tool
// produces deletes today; the branch exists so the adapter is total over
// FileChange and the v2 migration stays a pure adapter swap).
export function fileChangeToDiffContent(change: FileChange): ToolCallContent {
	switch (change.operation) {
		case "add":
			return { type: "diff", path: change.path, newText: change.newText ?? "", oldText: null }
		case "modify":
			return { type: "diff", path: change.path, newText: change.newText ?? "", oldText: change.oldText ?? null }
		case "delete":
			// The SDK's v1 Diff type marks newText required, but the protocol
			// treats it as absent for deletions (oldText is the "None for new
			// files" mirror). Cast keeps the wire shape per the v1 mapping.
			return { type: "diff", path: change.path, oldText: change.oldText ?? null } as ToolCallContent
	}
}

// Faithful replication of pi's resolveToCwd (dist/core/tools/path-utils.js →
// resolvePath with normalizeUnicodeSpaces + stripAtPrefix): the write tool
// resolves args.path this way, so the pre-write read must match or a path
// like "@notes.txt" or "~/file (with NBSP).md" would be misclassified as a
// new file. pi-coding-agent only exports "." and "./hooks", so the helper
// can't be imported — replicated here. Drift surfaces as an 'add' diff on an
// overwritten file, not corruption.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
function resolveToolPath(input: string, cwd: string): string {
	let p = input.replace(UNICODE_SPACES, " ")
	if (p.startsWith("@")) p = p.slice(1)
	if (p === "~") {
		p = homedir()
	} else if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
		p = join(homedir(), p.slice(2))
	}
	if (/^file:\/\//.test(p)) p = fileURLToPath(p)
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p)
}

// Reads the pre-write content for a `write` tool call. Returns null when the
// file doesn't exist yet (new-file add). Other read errors are logged — the
// diff still omits oldText rather than breaking the tool_call_update, but a
// swallowed EACCES/ETOOLARGE would otherwise be indistinguishable from
// "file did not exist".
function readPreWriteContent(toolPath: string, cwd: string): string | null {
	try {
		return readFileSync(resolveToolPath(toolPath, cwd), "utf-8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			process.stderr.write(`acp per-turn-diff: pre-write read failed for ${toolPath}: ${String(err)}\n`)
		}
		return null
	}
}

// Derives pending file-change entries from a tool's arguments. Only the
// mutation tools (edit, write) produce changes; everything else returns []
// so read-only tools never attach diffs.
function collectFileChanges(
	toolName: string,
	args: unknown,
	cwd: string,
	turn: { preWriteContents: Map<string, string | null> },
	toolCallId: string,
): PendingFileChange[] {
	const a = (args ?? {}) as Record<string, unknown>
	const path = typeof a.path === "string" ? a.path : undefined
	if (toolName === "edit") {
		if (!path) return []
		// pi's edit tool accepts the multi-edit shape {path, edits: [...]} and
		// normalizes a legacy single-edit shape {path, oldText, newText}
		// internally. Mirror that normalization so legacy-shape calls still
		// emit a diff instead of silently producing none.
		const editsInput: unknown[] = Array.isArray(a.edits)
			? a.edits
			: typeof a.oldText === "string" && typeof a.newText === "string"
				? [{ oldText: a.oldText, newText: a.newText }]
				: []
		const changes: FileChange[] = []
		for (const e of editsInput) {
			if (!e || typeof e !== "object") continue
			const edit = e as { oldText?: unknown; newText?: unknown }
			if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") continue
			changes.push({ operation: "modify", path, oldText: edit.oldText, newText: edit.newText })
		}
		return changes
	}
	if (toolName === "write") {
		if (!path || typeof a.content !== "string") return []
		// Capture the pre-existing content now (before the tool overwrites it).
		// The entry is stored with its operation undecided; tool_execution_end
		// resolves add-vs-modify from preWriteContents via resolveFileChange,
		// keeping that map the single source of truth for the write oldText.
		turn.preWriteContents.set(toolCallId, readPreWriteContent(path, cwd))
		return [{ operation: "write", path, newText: a.content }]
	}
	return []
}

// Resolves a captured-at-start entry to a concrete FileChange for the v1
// adapter. "write" entries become "add" when the file didn't exist (or the
// pre-write read failed, or no pre-write content was captured) and "modify"
// with the recorded oldText otherwise.
function resolveFileChange(pending: PendingFileChange, preWrite: string | null | undefined): FileChange {
	if (pending.operation !== "write") return pending
	return preWrite === null || preWrite === undefined
		? { operation: "add", path: pending.path, newText: pending.newText }
		: { operation: "modify", path: pending.path, oldText: preWrite, newText: pending.newText }
}

// UserMessage.content is `string | (TextContent | ImageContent)[]` per pi-ai
// types. Replay only surfaces text — Zed has no UX surface for historical
// image attachments, and the prompt capabilities advertise image: false so a
// future replay path that emits historical images would also need to flip
// that flag.
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
		if (m?.role !== "toolResult" || typeof m.toolCallId !== "string") continue
		out.set(m.toolCallId, {
			content: m.content,
			isError: m.isError === true,
			details: m.details,
			toolName: typeof m.toolName === "string" ? m.toolName : undefined,
		})
	}
	return out
}

function toolResultContent(result: unknown): ToolCallContent[] {
	// Tool results carry pi-ai content blocks, typed as (TextContent |
	// ImageContent)[] on pi-ai's ToolResultMessage. Forward both, so a tool that
	// emits an image (e.g. web_fetch, or an MCP image tool whose block survives
	// transformMcpContent) doesn't surface to the client as a completed call with
	// empty content.
	//
	// resource / resource_link / audio blocks never reach here: the MCP bridge
	// (transformMcpContent) already flattens them to text, because pi-ai tool
	// results only model text and image. Forwarding them as native ACP resource
	// blocks would require widening pi-ai's tool-result content type upstream.
	const r = result as { content?: unknown } | null | undefined
	const content = r?.content
	if (!Array.isArray(content)) return []
	const out: ToolCallContent[] = []
	for (const block of content) {
		if (!block || typeof block !== "object") continue
		const b = block as { type?: string; text?: string; data?: string; mimeType?: string }
		if (b.type === "text" && typeof b.text === "string") {
			out.push({ type: "content", content: { type: "text", text: b.text } })
		} else if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
			out.push({ type: "content", content: { type: "image", data: b.data, mimeType: b.mimeType } })
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
	const conn = new AgentSideConnection((c) => {
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
