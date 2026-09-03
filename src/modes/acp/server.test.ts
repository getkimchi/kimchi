import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type {
	AgentSideConnection,
	ListSessionsRequest,
	RequestPermissionRequest,
	SessionNotification,
	TextContent,
} from "@agentclientprotocol/sdk"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionEventListener,
	ExtensionContext,
	ExtensionUIContext,
	ModelRegistry,
	SessionInfo as PiSessionInfo,
	ResourceLoader,
	SessionManager,
	Skill,
	Theme,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock the browser auth flow so authenticate() can be tested without
// starting a real callback server or opening a browser.
vi.mock("../../cli-auth/index.js", () => ({
	authenticateViaBrowser: vi.fn(),
}))
// Mock config writes so tests don't touch the real config file, but keep
// DEFAULT_SKILL_PATHS so skill discovery in the ACP server works.
vi.mock("../../config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../config.js")>()
	return {
		...actual,
		writeApiKey: vi.fn(),
		clearApiKey: vi.fn(),
	}
})
// Mock the model cache refresh so tests don't hit the network.
vi.mock("../../models.js", () => ({
	updateModelsConfig: vi.fn(),
}))
// Pin getVersion() so initialize() agentInfo assertions are deterministic
// and don't depend on the repo's package.json.
const getVersionMock = vi.fn(() => "1.2.3-test")
vi.mock("../../utils.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../utils.js")>()
	return {
		...actual,
		getVersion: () => getVersionMock(),
	}
})

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme")
const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme")

import { populateCliArgs } from "../../cli-args.js"
import { authenticateViaBrowser } from "../../cli-auth/index.js"
import { clearApiKey, writeApiKey } from "../../config.js"
import { createMiniEventBus } from "../../extensions/__mocks__/mini-event-bus.js"
import { PARENT_SESSION_ID_ENV_KEY } from "../../extensions/agents/manager/constants.js"
import { setProcessOrchestratorRef } from "../../extensions/kimchi-process.js"
import { getMultiModelEnabled, setMultiModelEnabled } from "../../extensions/multi-model.js"
import { PERMISSION_MODES, PERMISSIONS_ENV_KEY } from "../../extensions/permissions/constants.js"
import { PERMISSION_MODE_SESSION_ENTRY_TYPE } from "../../extensions/permissions/mode.js"
import { getPermissionModeEnvKey } from "../../extensions/permissions/mode-controller.js"
import {
	getSessionPermissionFlagController,
	unregisterSessionPermissionFlagController,
} from "../../extensions/permissions/mode-controller-registry.js"
import { updateModelsConfig } from "../../models.js"
import { getAcpPrompter } from "./permission-prompter-registry.js"
import {
	type AcpSessionFactory,
	type AcpSessionLister,
	type AcpSessionLoader,
	assertSessionHasModel,
	buildSessionModelState,
	fileChangeToDiffContent,
	initializeHeadlessTheme,
	KimchiAcpAgent,
	stripAnsi,
	toAcpSessionInfo,
	userMessageText,
} from "./server.js"
import { getAcpClientInfo, resetAcpClientInfo } from "./state.js"
import { resolveAcpAppendSystemPrompt } from "./system-prompt.js"

function cleanPermissionEnv(): void {
	Reflect.deleteProperty(process.env, "KIMCHI_ACTIVE_FERMENT")
	Reflect.deleteProperty(process.env, PARENT_SESSION_ID_ENV_KEY)
	for (const key of Object.keys(process.env)) {
		if (key.startsWith(`${PERMISSIONS_ENV_KEY}_`)) {
			Reflect.deleteProperty(process.env, key)
		}
	}
	// Reset the CLI args cache so permission mode flags (--plan/--auto/--yolo)
	// set by one test don't leak into another via the module-level cache.
	populateCliArgs([])
}

beforeEach(cleanPermissionEnv)
beforeEach(() => {
	getVersionMock.mockReturnValue("1.2.3-test")
})
afterEach(cleanPermissionEnv)

/** Model shape used by FakeAgentSession's model registry. */
interface FakeModel {
	provider: string
	id: string
	name?: string
	input?: string[]
	contextWindow?: number
}

/** Options passed through `AgentSession.prompt()` to the fake. */
interface PromptOpts {
	images?: unknown[]
}

/** Record of one prompt call captured by FakeAgentSession. */
interface PromptCall {
	prompt: string
	opts?: PromptOpts
}

/** Context-usage stats surfaced to emitUsageUpdate. */
interface ContextUsage {
	tokens: number | null
	contextWindow: number
	percent: number | null
}

/** Token and cost stats returned by `AgentSession.getSessionStats()`. */
interface SessionStats {
	tokens: {
		input: number
		output: number
		cacheRead: number
		cacheWrite: number
		total: number
	}
	cost: number
}

/** One option entry inside a config option returned by the ACP server. */
interface SelectOptionItem {
	value: string
}

// Minimal fake of AgentSession surface used by KimchiAcpAgent. The factory seam
// means we only need to stand in for the methods the ACP server actually calls:
// sessionId, subscribe, prompt, abort, dispose. loadSession also reads
// `sessionManager.getBranch()` for replay and `model` for the response, so the
// fake exposes settable fields for both.
class FakeAgentSession {
	readonly sessionId: string
	private listeners = new Set<AgentSessionEventListener>()
	disposed = false
	aborted = false
	clearQueueCalls = 0
	clearQueueReturn = { steering: [] as string[], followUp: [] as string[] }
	// Steering-seam state for the cancel-ordering regression: steer() records
	// as pending, clearQueue() drops what was never delivered, and `order`
	// pins the clear-before-abort sequence. `emulatedHistory` receives
	// whatever an abort's wait lets pi-mono's steering chain deliver.
	pendingSteers: string[] = []
	emulatedHistory: string[] = []
	order: string[] = []
	model: FakeModel | undefined = {
		provider: "test",
		id: "test-model",
		name: "Test Model",
		input: ["text"],
		contextWindow: 200_000,
	}
	modelRegistry = {
		getAvailable: () =>
			this.model
				? [
						{
							provider: this.model.provider,
							id: this.model.id,
							name: this.model.name ?? this.model.id,
						},
					]
				: [],
		find: (provider: string, id: string) =>
			this.modelRegistry.getAvailable().find((m) => m.provider === provider && m.id === id),
	}
	promptImpl: (text: string, opts?: PromptOpts) => Promise<void> = async () => {}
	abortImpl: () => Promise<void> = async () => {}
	bindExtensionsImpl: (_bindings: unknown) => Promise<void> = async () => {}
	// Captures tool registration and activation state for parity assertions.
	registeredTools: Map<string, unknown> = new Map()
	activeToolNames: string[] = []
	lastPromptImages?: unknown[]
	promptCalls: PromptCall[] = []
	// Context-usage stats surfaced to emitUsageUpdate. Tests override these
	// to simulate provider-reported usage or the null/empty no-op path.
	contextUsage: ContextUsage | undefined = {
		tokens: 50_000,
		contextWindow: 200_000,
		percent: 25,
	}
	sessionStats: SessionStats = {
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
	}
	resourceLoader = {
		getSkills: () => ({ skills: [] as Skill[], diagnostics: [] }),
		getExtensions: () => ({ extensions: [], errors: [], runtime: undefined }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	} as unknown as ResourceLoader
	// Branch entries returned to the replay walker. Tests fill this with the
	// shape buildSessionContext consumers expect (type:"message" + role).
	branch: unknown[] = []
	sessionManager = {
		getBranch: () => this.branch,
		getSessionId: () => this.sessionId,
		getEntries: () => this.branch,
		getCwd: () => this.cwd,
		getSessionDir: () => `${this.cwd}/.fake-agent-sessions-dir`,
		appendCustomEntry: (customType: string, data?: unknown) => {
			this.branch.push({ type: "custom", customType, data })
			return "entry-id"
		},
	}
	// Captures whatever setUIContext the agent installs so tests can assert
	// on it. The real AgentSession exposes this via its extensionRunner
	// getter; the fake keeps it on the session root for simpler test wiring.
	setUIContextCalls: unknown[] = []
	extensionRunner = {
		setUIContext: (ui: unknown) => {
			this.setUIContextCalls.push(ui)
		},
		emit: async (_event: unknown) => {
			// Real runner exposes emit for session lifecycle events; the fake
			// just resolves so disposeSessionRecord's session_shutdown hook
			// doesn't throw.
		},
	}

	constructor(
		sessionId: string,
		private readonly cwd: string = "/tmp",
	) {
		this.sessionId = sessionId
		// Tests assume deterministic single-model state by default. The global
		// multi-model default may differ between local and CI, so pin it here.
		setMultiModelEnabled(sessionId, false)
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	emit(event: AgentSessionEvent): void {
		for (const l of [...this.listeners]) l(event)
	}

	async prompt(text: string, opts?: { images?: unknown[] }): Promise<void> {
		this.lastPromptImages = opts?.images
		this.promptCalls.push({ prompt: text, opts })
		await this.promptImpl(text, opts)
	}

	async setModel(model: { provider: string; id: string }): Promise<void> {
		this.model = model
	}

	async abort(): Promise<void> {
		this.aborted = true
		this.order.push("abort")
		await this.abortImpl()
	}

	async steer(text: string, _images?: unknown[]): Promise<void> {
		this.pendingSteers.push(text)
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		this.clearQueueCalls++
		this.order.push("clearQueue")
		this.pendingSteers = []
		return this.clearQueueReturn
	}

	async bindExtensions(bindings: unknown): Promise<void> {
		await this.bindExtensionsImpl(bindings)
	}

	getToolDefinition(name: string): unknown {
		return this.registeredTools.get(name)
	}

	getActiveToolNames(): string[] {
		return [...this.activeToolNames]
	}

	setActiveToolsByName(names: string[]): void {
		this.activeToolNames = [...names]
	}

	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
		return this.contextUsage
	}

	getSessionStats(): {
		tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
		cost: number
	} {
		return this.sessionStats
	}

	dispose(): void {
		this.disposed = true
		this.listeners.clear()
	}
}

function asSession(fake: FakeAgentSession): AgentSession {
	return fake as unknown as AgentSession
}

function makeConn(): AgentSideConnection {
	const stub = {
		sessionUpdate: async (_p: SessionNotification) => {},
	}
	return stub as unknown as AgentSideConnection
}

// Recording variant of makeConn: captures every sessionUpdate the agent emits
// so tests can assert on the full notification stream (tool_call, partial
// tool_call_update, terminal tool_call_update, etc.).
function makeRecordingConn(): {
	conn: AgentSideConnection
	updates: SessionNotification[]
} {
	const updates: SessionNotification[] = []
	const stub = {
		sessionUpdate: async (p: SessionNotification) => {
			updates.push(p)
		},
		requestPermission: vi.fn().mockResolvedValue({ outcome: "cancelled" }),
	}
	return { conn: stub as unknown as AgentSideConnection, updates }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function agentEnd(): AgentSessionEvent {
	return { type: "agent_end", messages: [], willRetry: false }
}

// Drop the incidental `available_commands_update` re-broadcast on session
// resume so replay tests can assert on transcript shape alone.
function replayOnly(updates: SessionNotification[]): SessionNotification[] {
	return updates.filter((u) => u.update.sessionUpdate !== "available_commands_update")
}

describe("KimchiAcpAgent turn lifecycle", () => {
	let fake: FakeAgentSession
	let agent: KimchiAcpAgent
	let sessionId: string

	beforeEach(async () => {
		fake = new FakeAgentSession("session-a")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})
		const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		sessionId = res.sessionId
	})

	// initialize() should declare image support based on cached models.json
	describe("initialize capability detection", () => {
		const tempAgentDir = "/tmp/kimchi-acp-test-agent-dir"

		beforeEach(() => {
			// Clean up and create temp agent dir
			try {
				rmSync(tempAgentDir, { recursive: true, force: true })
			} catch {}
			mkdirSync(tempAgentDir, { recursive: true })
		})

		afterEach(() => {
			try {
				rmSync(tempAgentDir, { recursive: true, force: true })
			} catch {}
		})

		it("declares image: true when cached models include vision models", async () => {
			// Stub API key so models are considered "available" (configured auth)
			const restoreEnv = (key: string, value: string | undefined) => {
				const original = process.env[key]
				process.env[key] = value
				return () => {
					process.env[key] = original
				}
			}
			const cleanup = restoreEnv("OPENAI_API_KEY", "fake-key-for-testing")

			try {
				// pi-mono auth resolution reads the stored credentials file, not the
				// OPENAI_API_KEY env var — availability requires a real auth entry
				// on disk (probe: env stub alone leaves auth configured: false).
				writeFileSync(
					resolve(tempAgentDir, "auth.json"),
					JSON.stringify({ openai: { type: "api_key", key: "fake-key" } }),
				)
				const modelsJson = {
					providers: {
						openai: {
							baseUrl: "https://api.openai.com/v1",
							models: [
								{
									id: "gpt-4o",
									name: "GPT-4o",
									api: "openai-responses",
									input: ["text", "image"],
								},
							],
						},
					},
				}
				writeFileSync(resolve(tempAgentDir, "models.json"), JSON.stringify(modelsJson))

				const testAgent = new KimchiAcpAgent(makeConn(), {
					extensionFactories: [],
					agentDir: tempAgentDir,
					sessionFactory: async () => asSession(fake),
				})

				const response = await testAgent.initialize({ protocolVersion: 1 })
				expect(response.agentCapabilities?.promptCapabilities?.image).toBe(true)
			} finally {
				cleanup()
			}
		})

		it("declares image capability based on available models", async () => {
			// ModelRegistry merges cached models with built-in defaults.
			// This test verifies the initialize() method correctly queries
			// the registry and returns a boolean for image support.
			const testAgent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tempAgentDir,
				sessionFactory: async () => asSession(fake),
			})

			const response = await testAgent.initialize({ protocolVersion: 1 })
			// The result depends on merged models (cached + built-in).
			// Just verify it's a boolean (the logic ran successfully).
			expect(typeof response.agentCapabilities?.promptCapabilities?.image).toBe("boolean")
		})

		it("records ACP client name during initialize", async () => {
			resetAcpClientInfo()
			const testAgent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tempAgentDir,
				sessionFactory: async () => asSession(fake),
			})

			await testAgent.initialize({
				protocolVersion: 1,
				clientInfo: { name: "kimchi-vscode", version: "1.0.0" },
			})

			const info = getAcpClientInfo()
			expect(info?.name).toBe("kimchi-vscode")
			expect(info?.version).toBe("1.0.0")
		})

		// ACP Registry compliance: initialize() must advertise auth methods so
		// kimchi can be listed in the ACP registry (requires at least one of
		// Agent Auth or Terminal Auth). See:
		// https://github.com/agentclientprotocol/registry/blob/main/AUTHENTICATION.md
		it("declares agent auth method in initialize response", async () => {
			const testAgent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tempAgentDir,
				sessionFactory: async () => asSession(fake),
			})

			const response = await testAgent.initialize({ protocolVersion: 1 })
			expect(response.authMethods).toHaveLength(1)
			expect(response.authMethods?.[0]).toMatchObject({
				id: "kimchi-agent",
				name: "Kimchi Login",
			})
			// Agent Auth is the default: the descriptor omits `type` (the
			// registry treats an absent type as "agent"). AuthMethodAgent has no
			// `type` field, so we verify absence rather than equality.
			const method = response.authMethods?.[0]
			expect("type" in (method ?? {})).toBe(false)
		})

		it("declares terminal auth method when client supports terminal capability", async () => {
			const testAgent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tempAgentDir,
				sessionFactory: async () => asSession(fake),
			})

			const response = await testAgent.initialize({
				protocolVersion: 1,
				clientCapabilities: { auth: { terminal: true } },
			})
			expect(response.authMethods).toHaveLength(2)
			const terminalMethod = response.authMethods?.find((m) => "type" in m && m.type === "terminal")
			expect(terminalMethod).toMatchObject({
				id: "kimchi-terminal",
				name: "Log in from terminal",
				type: "terminal",
				args: ["login"],
			})
		})

		it("omits terminal auth method when client does not support terminal capability", async () => {
			const testAgent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tempAgentDir,
				sessionFactory: async () => asSession(fake),
			})

			// No clientCapabilities at all
			const response = await testAgent.initialize({ protocolVersion: 1 })
			expect(response.authMethods).toHaveLength(1)
			expect(response.authMethods?.some((m) => "type" in m && m.type === "terminal")).toBe(false)

			// clientCapabilities present but auth.terminal is false/omitted
			const response2 = await testAgent.initialize({
				protocolVersion: 1,
				clientCapabilities: { auth: { terminal: false } },
			})
			expect(response2.authMethods).toHaveLength(1)
			expect(response2.authMethods?.some((m) => "type" in m && m.type === "terminal")).toBe(false)
		})

		it("advertises logout capability in agentCapabilities.auth", async () => {
			const testAgent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tempAgentDir,
				sessionFactory: async () => asSession(fake),
			})

			const response = await testAgent.initialize({ protocolVersion: 1 })
			expect(response.agentCapabilities?.auth?.logout).toEqual({})
		})

		it("includes agentInfo with name kimchi and current version", async () => {
			const testAgent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tempAgentDir,
				sessionFactory: async () => asSession(fake),
			})

			getVersionMock.mockReturnValue("9.8.7-test")

			const response = await testAgent.initialize({ protocolVersion: 1 })
			expect(response.agentInfo).toEqual({
				name: "kimchi",
				version: "9.8.7-test",
			})
		})

		it("reflects the live getVersion() value in agentInfo.version", async () => {
			const testAgent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tempAgentDir,
				sessionFactory: async () => asSession(fake),
			})

			getVersionMock.mockReturnValue("0.0.0-canary.42")

			const response = await testAgent.initialize({ protocolVersion: 1 })
			expect(response.agentInfo?.name).toBe("kimchi")
			expect(response.agentInfo?.version).toBe("0.0.0-canary.42")
		})
	})

	describe("authenticate", () => {
		const tempAgentDir = "/tmp/kimchi-acp-test-agent-dir-auth"

		beforeEach(() => {
			try {
				rmSync(tempAgentDir, { recursive: true, force: true })
			} catch {}
			mkdirSync(tempAgentDir, { recursive: true })
			vi.mocked(authenticateViaBrowser).mockReset()
			vi.mocked(writeApiKey).mockReset()
			vi.mocked(updateModelsConfig).mockReset()
		})

		afterEach(() => {
			try {
				rmSync(tempAgentDir, { recursive: true, force: true })
			} catch {}
		})

		it("authenticates with kimchi-agent methodId: runs browser login and persists token", async () => {
			vi.mocked(authenticateViaBrowser).mockResolvedValue({ token: "castai_v1_test-token" })

			const testAgent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tempAgentDir,
				sessionFactory: async () => asSession(fake),
			})

			const result = await testAgent.authenticate({ methodId: "kimchi-agent" })

			expect(result).toEqual({})
			expect(authenticateViaBrowser).toHaveBeenCalledOnce()
			expect(writeApiKey).toHaveBeenCalledWith("castai_v1_test-token")
			expect(updateModelsConfig).toHaveBeenCalledWith(join(tempAgentDir, "models.json"), "castai_v1_test-token")
		})

		it("throws invalidParams for unknown methodId", async () => {
			const testAgent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tempAgentDir,
				sessionFactory: async () => asSession(fake),
			})

			await expect(testAgent.authenticate({ methodId: "unknown" })).rejects.toThrow(/unknown auth method/)
			expect(authenticateViaBrowser).not.toHaveBeenCalled()
		})

		it("throws when browser auth returns no token", async () => {
			vi.mocked(authenticateViaBrowser).mockResolvedValue({ token: "" })
			const testAgent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tempAgentDir,
				sessionFactory: async () => asSession(fake),
			})

			await expect(testAgent.authenticate({ methodId: "kimchi-agent" })).rejects.toThrow(/did not return a token/)
			expect(writeApiKey).not.toHaveBeenCalled()
		})

		it("wraps browser auth errors as RequestError.internalError", async () => {
			vi.mocked(authenticateViaBrowser).mockRejectedValue(new Error("User cancelled"))
			const testAgent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tempAgentDir,
				sessionFactory: async () => asSession(fake),
			})

			await expect(testAgent.authenticate({ methodId: "kimchi-agent" })).rejects.toThrow(
				/Browser authentication failed/,
			)
			expect(writeApiKey).not.toHaveBeenCalled()
		})
	})

	describe("unstable_logout", () => {
		const tempAgentDir = "/tmp/kimchi-acp-test-agent-dir-logout"

		beforeEach(() => {
			try {
				rmSync(tempAgentDir, { recursive: true, force: true })
			} catch {}
			mkdirSync(tempAgentDir, { recursive: true })
			vi.mocked(clearApiKey).mockReset()
		})

		afterEach(() => {
			try {
				rmSync(tempAgentDir, { recursive: true, force: true })
			} catch {}
		})

		it("clears API key from config and OAuth credentials from auth storage", async () => {
			// Seed auth.json with a kimchi-dev OAuth entry so we can verify
			// logout actually removes it.
			writeFileSync(
				join(tempAgentDir, "auth.json"),
				JSON.stringify({
					"kimchi-dev": { type: "oauth", accessToken: "old-token", refreshToken: "old-refresh" },
				}),
			)

			const testAgent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tempAgentDir,
				sessionFactory: async () => asSession(fake),
			})

			const result = await testAgent.unstable_logout({})

			expect(result).toEqual({})
			// clearApiKey is mocked — verify it was called to clear the config file.
			expect(clearApiKey).toHaveBeenCalledOnce()

			// AuthStorage.logout("kimchi-dev") should have removed the entry
			// from auth.json. Read it back and verify.
			const authJson = JSON.parse(
				// eslint-disable-next-line no-restricted-syntax
				await import("node:fs").then((fs) => fs.readFileSync(join(tempAgentDir, "auth.json"), "utf-8")),
			)
			expect(authJson["kimchi-dev"]).toBeUndefined()
		})
	})

	// session.prompt() is the source of truth for "turn is done". When events
	// arrive AFTER session.prompt resolves (e.g. a slow downstream handler
	// awaited something), the turn was already finalized on session.prompt
	// resolve — late events must be dropped. agent_end no longer drives
	// finalization, so it cannot be used as a barrier. If this ever regresses
	// to "wait for late agent_end", we'd be vulnerable to the chained
	// agent.continue() bug again.
	it("drops late turn events that arrive after session.prompt resolves", async () => {
		let lateEventsFired = false
		fake.promptImpl = async () => {
			await delay(5)
			setTimeout(() => {
				fake.emit({ type: "agent_start" })
				fake.emit(agentEnd())
				lateEventsFired = true
			}, 30)
		}

		const result = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "hi" }],
		})
		expect(result.stopReason).toBe("end_turn")
		expect(lateEventsFired).toBe(false)

		await delay(40)
		expect(lateEventsFired).toBe(true)
	})

	// Extension-command / input-handler / no-op path: session.prompt returns
	// without emitting any agent events. The ACP handler must synthesize
	// end_turn itself — no agent_end is ever coming.
	it("synthesizes end_turn when the turn short-circuits without agent_start", async () => {
		fake.promptImpl = async () => {
			// No events emitted — exactly like an extension-command path.
		}

		const result = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "/help" }],
		})

		expect(result.stopReason).toBe("end_turn")
	})

	// Regression: pi-mono's _runAgentPrompt chains multiple agent.prompt /
	// agent.continue calls when retries, queued follow-up messages, or
	// compaction are pending. Each chained call emits its own agent_start +
	// agent_end pair. Previously the ACP handler finalized on the FIRST
	// agent_end, sending end_turn mid-stream — the client then tried to send
	// a new prompt and hit pi-mono's "Agent is already processing" throw
	// because session.prompt was still running the chained continues.
	// Now: end_turn is sent exactly once, only after session.prompt()
	// resolves (i.e. after ALL chained calls complete).
	it("sends exactly one end_turn after chained agent.continue() cycles complete", async () => {
		const { conn: recordingConn, updates } = makeRecordingConn()
		const localAgent = new KimchiAcpAgent(recordingConn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})
		const res = await localAgent.newSession({ cwd: "/tmp", mcpServers: [] })
		const localSessionId = res.sessionId

		fake.promptImpl = async () => {
			// Cycle 1 — first agent.prompt call.
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "first",
					contentIndex: 0,
					partial: {} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit(agentEnd())
			await delay(5)
			// Cycle 2 — agent.continue() (e.g. follow-up message queued,
			// retry needed, or compaction). The user-visible bug is that the
			// FIRST agent_end used to trigger end_turn here, dropping cycle 2.
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "second",
					contentIndex: 0,
					partial: {} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit(agentEnd())
		}

		const result = await localAgent.prompt({
			sessionId: localSessionId,
			prompt: [{ type: "text", text: "go" }],
		})

		// Single end_turn, with stopReason "end_turn".
		expect(result.stopReason).toBe("end_turn")

		// Both cycles' chunks reach the client. Under the OLD behavior,
		// the first agent_end would have cleared entry.turn and dropped
		// every cycle-2 event — so this assertion is the bug-reproducer.
		const chunks = updates.flatMap((u) =>
			u.update.sessionUpdate === "agent_message_chunk" ? [(u.update.content as TextContent).text] : [],
		)
		expect(chunks).toEqual(["first", "second"])
	})

	// Cancel arrives between chained agent.continue() cycles. Cycle 1 completes
	// normally (agent_start → message_update → agent_end), then the client calls
	// cancel() before cycle 2 starts. session.prompt() resolves (abort may or may
	// not prevent the next continue), and the .then() handler sees cancelled=true.
	// The first cycle's chunks must still reach the client; the result must be
	// "cancelled", not "end_turn".
	it("resolves cancelled when cancel arrives between chained agent.continue() cycles", async () => {
		const { conn: recordingConn, updates } = makeRecordingConn()
		const localAgent = new KimchiAcpAgent(recordingConn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})
		const res = await localAgent.newSession({ cwd: "/tmp", mcpServers: [] })
		const localSessionId = res.sessionId

		let cancelSeen = false
		fake.promptImpl = async () => {
			// Cycle 1 — completes normally.
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "before-cancel",
					contentIndex: 0,
					partial: {} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit(agentEnd())

			// Simulate the async boundary between chained calls where
			// _handlePostAgentRun decides whether to continue. The client's
			// cancel() lands here.
			while (!cancelSeen) await delay(5)

			// Cycle 2 — would have run, but abort arrived. In real pi-mono the
			// next agent.continue() may not even start; simulate the benign case
			// where it does start but produces nothing meaningful before abort
			// tears it down.
			fake.emit({ type: "agent_start" })
			fake.emit(agentEnd())
		}
		fake.abortImpl = async () => {
			cancelSeen = true
		}

		const promptP = localAgent.prompt({
			sessionId: localSessionId,
			prompt: [{ type: "text", text: "go" }],
		})
		// Let cycle 1 complete and the promptImpl pause at the while-loop.
		await delay(20)
		await localAgent.cancel({ sessionId: localSessionId })

		const result = await promptP
		expect(result.stopReason).toBe("cancelled")
		expect(fake.aborted).toBe(true)

		// Cycle 1's chunk must have been delivered before cancellation.
		const chunks = updates.flatMap((u) =>
			u.update.sessionUpdate === "agent_message_chunk" ? [(u.update.content as TextContent).text] : [],
		)
		expect(chunks).toContain("before-cancel")
	})

	// Client cancels mid-turn: cancelled=true is set on the turn context, then
	// agent_end fires and the subscriber finalizes with stopReason=cancelled.
	it("resolves cancelled when cancel fires before agent_end", async () => {
		let cancelSeen = false
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			// Wait until cancel() runs.
			while (!cancelSeen) await delay(5)
			// pi-mono's abort path still emits agent_end on teardown.
			fake.emit(agentEnd())
		}
		fake.abortImpl = async () => {
			cancelSeen = true
		}

		const promptP = agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run forever" }],
		})
		// Give the prompt a moment to arm the turn context.
		await delay(10)
		await agent.cancel({ sessionId })

		const result = await promptP
		expect(result.stopReason).toBe("cancelled")
		expect(fake.aborted).toBe(true)
	})

	// Cancel path where pi-mono surfaces abortion as a rejection instead of a
	// final agent_end: the RPC contract still demands stopReason="cancelled",
	// not a JSON-RPC error. The prompt() catch block must honor cancelled=true
	// and resolve, not reject.
	it("resolves cancelled when session.prompt rejects after cancel", async () => {
		let cancelSeen = false
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			while (!cancelSeen) await delay(5)
			// Simulate pi-mono's "abort throws out of prompt()" variant — no
			// agent_end is emitted before the rejection.
			throw new Error("AbortError: operation was aborted")
		}
		fake.abortImpl = async () => {
			cancelSeen = true
		}

		const promptP = agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run forever" }],
		})
		await delay(10)
		await agent.cancel({ sessionId })

		const result = await promptP
		expect(result.stopReason).toBe("cancelled")
		expect(fake.aborted).toBe(true)
	})

	// cancel() must drain the steer/follow-up queue so queued text doesn't
	// leak into the next prompt — mirrors the TUI's Escape → clearAllQueues().
	it("drains the steer queue when cancel arrives mid-turn", async () => {
		let cancelSeen = false
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			while (!cancelSeen) await delay(5)
			fake.emit(agentEnd())
		}
		fake.abortImpl = async () => {
			cancelSeen = true
		}

		const promptP = agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run forever" }],
		})
		await delay(10)
		await agent.cancel({ sessionId })

		await promptP
		expect(fake.aborted).toBe(true)
		expect(fake.clearQueueCalls).toBe(1)
	})

	// Arms a turn that hangs until abort() runs — emulating a still-running
	// turn when session/cancel arrives. onAbort runs inside abortImpl after
	// the hang flag flips, while prompt() is still parked.
	function armHangingTurn(onAbort?: () => void): void {
		let cancelSeen = false
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			while (!cancelSeen) await delay(5)
			fake.emit(agentEnd())
		}
		fake.abortImpl = async () => {
			cancelSeen = true
			onAbort?.()
		}
	}

	// Regression: cancel() must drain the queue BEFORE awaiting the abort.
	// pi-mono chains queued steering messages into the running prompt —
	// session.prompt() resolves only after all chained calls — so awaiting
	// abort() first lets every queued steer self-deliver into history one
	// reply at a time (observed in dogfooding: steers landing +3.7s/+10.9s
	// after the abort, each with a full reply). The fake's abortImpl
	// emulates that chaining by delivering whatever is still pending.
	it("never delivers queued steers after cancel", async () => {
		// Emulate pi-mono's steering chain: a waiting abort() gives every
		// still-queued steer time to deliver into the session's history.
		armHangingTurn(() => {
			for (const text of fake.pendingSteers) {
				fake.emulatedHistory.push(text)
			}
		})

		const promptP = agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "t1" }],
		})
		await delay(10)
		await fake.steer("t2")
		await fake.steer("t3")

		await agent.cancel({ sessionId })

		const result = await promptP
		expect(result.stopReason).toBe("cancelled")
		expect(fake.emulatedHistory).toEqual([])
		expect(fake.order).toEqual(["clearQueue", "abort"])
	})

	// clearQueue() throwing must not skip the abort — the turn is already
	// marked cancelled, and leaving the agent running would burn tokens
	// until the LLM responds. try/finally guarantees abort runs regardless.
	it("still aborts when clearQueue throws", async () => {
		armHangingTurn()
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		fake.clearQueue = (): { steering: string[]; followUp: string[] } => {
			throw new Error("clearQueue boom")
		}

		const promptP = agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "t1" }],
		})
		await delay(10)

		// cancel() must resolve — clearQueue's error is caught so abort still runs.
		await agent.cancel({ sessionId })

		const result = await promptP
		expect(result.stopReason).toBe("cancelled")
		expect(fake.aborted).toBe(true)
		// The drain failure is logged, not silently swallowed — a recurring
		// clearQueue failure must be observable, not re-leak steers quietly.
		expect(errorSpy).toHaveBeenCalledWith(
			"kimchi acp: clearQueue() failed during cancel; aborting anyway",
			expect.any(Error),
		)
		errorSpy.mockRestore()
	})

	// If session.prompt throws (pre-turn validation, config error, etc.), the
	// outer RPC promise must reject — not hang — regardless of whether any
	// events were emitted before the throw.
	it("rejects the outer prompt when session.prompt throws", async () => {
		fake.promptImpl = async () => {
			throw new Error("no model configured")
		}

		await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] })).rejects.toThrow(
			/no model configured/,
		)
	})

	// Chained continues: cycle 1 succeeds but cycle 2's agent.continue() throws
	// a non-abort error (e.g. context overflow during compaction retry). The
	// .catch() handler must propagate the error since cancelled is false — the
	// client sees a JSON-RPC error, not a silent end_turn that hides the failure.
	it("rejects the outer prompt when a chained agent.continue() throws a non-abort error", async () => {
		fake.promptImpl = async () => {
			// Cycle 1 — completes normally.
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "partial",
					contentIndex: 0,
					partial: {} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit(agentEnd())
			await delay(5)
			// Cycle 2 — blows up.
			fake.emit({ type: "agent_start" })
			throw new Error("context window overflow during compaction")
		}

		await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] })).rejects.toThrow(
			/context window overflow during compaction/,
		)
	})

	// shutdown() must not leave pending PromptResponse promises dangling.
	// When the caller awaits shutdown (e.g. runAcpMode's finally after
	// conn.closed resolves) an in-flight turn must be rejected so the prompt
	// caller's await settles rather than hanging until process exit.
	it("rejects in-flight turns when shutdown() is called", async () => {
		let resumePrompt!: () => void
		const pending = new Promise<void>((resolve) => {
			resumePrompt = resolve
		})
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			await pending // never resolves on its own in this test
		}

		const promptP = agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "hang forever" }],
		})
		// Pre-attach catch handler so the rejection fires synchronously during
		// shutdown without landing as an unhandled rejection.
		const caught = promptP.catch((err) => err)
		// Arm the turn.
		await delay(10)

		await agent.shutdown()
		const err = await caught
		expect(err).toBeInstanceOf(Error)
		expect((err as Error).message).toMatch(/shutting down/)
		// Cleanup the dangling promptImpl.
		resumePrompt()
		expect(fake.disposed).toBe(true)
	})

	// Misbehaving client sends a block type our capabilities declared as
	// unsupported (image/audio/embeddedContext). The server drops it silently
	// from the text payload but must warn on stderr so a dev debugging the
	// resulting empty-turn sees what happened. Warn exactly once per type.
	it("warns once on stderr for unsupported prompt block types", async () => {
		const writes: string[] = []
		const origWrite = process.stderr.write.bind(process.stderr)
		// biome-ignore lint/suspicious/noExplicitAny: test-only stderr capture
		;(process.stderr.write as any) = (chunk: string | Uint8Array) => {
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
			return true
		}
		try {
			const r1 = await agent.prompt({
				sessionId,
				// biome-ignore lint/suspicious/noExplicitAny: unsupported block on purpose
				prompt: [{ type: "audio" as any, data: "x" } as any],
			})
			expect(r1.stopReason).toBe("end_turn")
			// Second call with same unsupported type: no new warning (deduped).
			const r2 = await agent.prompt({
				sessionId,
				// biome-ignore lint/suspicious/noExplicitAny: unsupported block on purpose
				prompt: [{ type: "audio" as any, data: "y" } as any],
			})
			expect(r2.stopReason).toBe("end_turn")
			// New unsupported type: warns again.
			const r3 = await agent.prompt({
				sessionId,
				// biome-ignore lint/suspicious/noExplicitAny: unsupported block on purpose
				prompt: [{ type: "embeddedContext" as any, data: "z" } as any],
			})
			expect(r3.stopReason).toBe("end_turn")
		} finally {
			process.stderr.write = origWrite
		}
		const matches = writes.filter((w) => w.includes("acp prompt: dropping"))
		expect(matches).toHaveLength(2)
		expect(matches.some((w) => w.includes("audio block"))).toBe(true)
		expect(matches.some((w) => w.includes("embeddedContext block"))).toBe(true)
	})

	// Image blocks are supported when model supports vision: they should be
	// extracted and passed to session.prompt() without warnings.
	it("accepts image blocks when model supports vision", async () => {
		fake.model = {
			provider: "test",
			id: "vision-model",
			input: ["text", "image"],
		}
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			await delay(5)
			fake.emit(agentEnd())
		}

		const result = await agent.prompt({
			sessionId,
			prompt: [
				{ type: "text", text: "describe this image" },
				{ type: "image", data: "base64data", mimeType: "image/png" },
			],
		})
		expect(result.stopReason).toBe("end_turn")
		// Verify images were passed to session.prompt
		expect(fake.lastPromptImages).toHaveLength(1)
		expect(fake.lastPromptImages?.[0]).toMatchObject({
			type: "image",
			data: "base64data",
			mimeType: "image/png",
		})
	})

	// Image blocks are dropped when model doesn't support vision: they should
	// be silently discarded with a warning.
	it("drops image blocks when model has no vision support", async () => {
		fake.model = { provider: "test", id: "text-only-model", input: ["text"] }
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			await delay(5)
			fake.emit(agentEnd())
		}

		const writes: string[] = []
		const origWrite = process.stderr.write.bind(process.stderr)
		// biome-ignore lint/suspicious/noExplicitAny: test-only stderr capture
		;(process.stderr.write as any) = (chunk: string | Uint8Array) => {
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
			return true
		}

		try {
			const result = await agent.prompt({
				sessionId,
				prompt: [
					{ type: "text", text: "describe this image" },
					{ type: "image", data: "base64data", mimeType: "image/png" },
				],
			})
			expect(result.stopReason).toBe("end_turn")
			// Images should be dropped, not passed to session.prompt (passed as empty array)
			expect(fake.lastPromptImages).toEqual([])
		} finally {
			process.stderr.write = origWrite
		}

		const matches = writes.filter((w) =>
			w.includes("acp prompt: dropping image block (active model has no vision input)"),
		)
		expect(matches).toHaveLength(1)
	})

	// Defensive: once a turn is finalized (short-circuit, shutdown, cancel),
	// stray tool_execution_{start,end} must not emit tool_call notifications
	// to the client. Clients would otherwise see tool activity on a turn they
	// consider complete. Checked alongside the existing agent_end drop test.
	it("drops stray tool_execution_start/end after a short-circuited turn", async () => {
		const localFake = new FakeAgentSession("session-tool-late")
		const factory: AcpSessionFactory = async () => asSession(localFake)
		const { conn, updates } = makeRecordingConn()
		const localAgent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		const { sessionId: sid } = await localAgent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		})

		localFake.promptImpl = async () => {
			// Short-circuit: no events.
		}
		const result = await localAgent.prompt({
			sessionId: sid,
			prompt: [{ type: "text", text: "/help" }],
		})
		expect(result.stopReason).toBe("end_turn")
		const updatesBefore = updates.length

		// Stray tool events arrive after finalization — must be dropped.
		localFake.emit({
			type: "tool_execution_start",
			toolCallId: "tc-late",
			toolName: "bash",
			args: { command: "late" },
		})
		localFake.emit({
			type: "tool_execution_end",
			toolCallId: "tc-late",
			toolName: "bash",
			result: { content: [{ type: "text", text: "late" }] },
			isError: false,
		})
		expect(updates.length).toBe(updatesBefore)
	})

	// Defensive: a late agent_end arriving after the short-circuit path has
	// already finalized must be a no-op, not a crash or double-resolve.
	it("ignores a late agent_end after a short-circuited turn", async () => {
		fake.promptImpl = async () => {
			// No events.
		}
		const result = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "/help" }],
		})
		expect(result.stopReason).toBe("end_turn")

		// Stray agent_end arrives later (shouldn't happen in production, but
		// the guard in onSessionEvent must keep us safe either way).
		expect(() => fake.emit(agentEnd())).not.toThrow()
	})

	it("emits a usage_update notification with used/size after a turn resolves", async () => {
		const { conn, updates } = makeRecordingConn()
		const localFake = new FakeAgentSession("session-usage")
		localFake.model = { provider: "test", id: "m", name: "M", input: ["text"], contextWindow: 200_000 }
		localFake.contextUsage = { tokens: 50_000, contextWindow: 200_000, percent: 25 }
		localFake.sessionStats = {
			tokens: { input: 10_000, output: 5_000, cacheRead: 0, cacheWrite: 0, total: 15_000 },
			cost: 0,
		}
		const localAgent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(localFake),
		})
		const { sessionId: sid } = await localAgent.newSession({ cwd: "/tmp", mcpServers: [] })

		localFake.promptImpl = async () => {
			localFake.emit({ type: "agent_start" })
			localFake.emit(agentEnd())
		}
		const result = await localAgent.prompt({
			sessionId: sid,
			prompt: [{ type: "text", text: "hi" }],
		})
		expect(result.stopReason).toBe("end_turn")

		const usageUpdates = updates.filter(
			(u) => (u.update as { sessionUpdate?: string }).sessionUpdate === "usage_update",
		)
		expect(usageUpdates).toHaveLength(1)
		expect(usageUpdates[0].sessionId).toBe(sid)
		expect((usageUpdates[0].update as { used: number; size: number }).used).toBe(50_000)
		expect((usageUpdates[0].update as { used: number; size: number }).size).toBe(200_000)
	})

	it("does not emit usage_update when getContextUsage tokens is null (post-compaction)", async () => {
		const { conn, updates } = makeRecordingConn()
		const localFake = new FakeAgentSession("session-usage-fallback")
		localFake.model = { provider: "test", id: "m", name: "M", input: ["text"], contextWindow: 128_000 }
		localFake.contextUsage = { tokens: null, contextWindow: 128_000, percent: null }
		localFake.sessionStats = {
			tokens: { input: 8_000, output: 2_000, cacheRead: 0, cacheWrite: 0, total: 10_000 },
			cost: 0,
		}
		const localAgent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(localFake),
		})
		const { sessionId: sid } = await localAgent.newSession({ cwd: "/tmp", mcpServers: [] })

		localFake.promptImpl = async () => {
			localFake.emit({ type: "agent_start" })
			localFake.emit(agentEnd())
		}
		const result = await localAgent.prompt({
			sessionId: sid,
			prompt: [{ type: "text", text: "hi" }],
		})
		expect(result.stopReason).toBe("end_turn")

		const usageUpdates = updates.filter(
			(u) => (u.update as { sessionUpdate?: string }).sessionUpdate === "usage_update",
		)
		// Per the issue doc: skip when tokens is null — no fallback to getSessionStats.
		expect(usageUpdates).toHaveLength(0)
	})

	it("does not emit usage_update when size is unavailable (no contextWindow)", async () => {
		const { conn, updates } = makeRecordingConn()
		const localFake = new FakeAgentSession("session-usage-no-size")
		localFake.model = { provider: "test", id: "m", name: "M", input: ["text"] }
		localFake.contextUsage = undefined
		localFake.sessionStats = {
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		}
		const localAgent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(localFake),
		})
		const { sessionId: sid } = await localAgent.newSession({ cwd: "/tmp", mcpServers: [] })

		localFake.promptImpl = async () => {
			localFake.emit({ type: "agent_start" })
			localFake.emit(agentEnd())
		}
		const result = await localAgent.prompt({
			sessionId: sid,
			prompt: [{ type: "text", text: "hi" }],
		})
		expect(result.stopReason).toBe("end_turn")

		const usageUpdates = updates.filter(
			(u) => (u.update as { sessionUpdate?: string }).sessionUpdate === "usage_update",
		)
		expect(usageUpdates).toHaveLength(0)
	})

	// Resource safety on the newSession error path: if subscribe (or any step
	// between factory-returns-session and sessions.set) throws, the live session
	// must be disposed — nothing else will ever clean it up.
	it("disposes the session if subscribe throws during newSession", async () => {
		const leaky = new FakeAgentSession("session-leak")
		leaky.subscribe = () => {
			throw new Error("subscribe boom")
		}
		const factory: AcpSessionFactory = async () => asSession(leaky)
		const localAgent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})

		await expect(localAgent.newSession({ cwd: "/tmp", mcpServers: [] })).rejects.toThrow(/subscribe boom/)
		expect(leaky.disposed).toBe(true)
	})

	it("unregisters the ACP permission prompter if bindExtensions throws during newSession", async () => {
		const leaky = new FakeAgentSession("session-bind-leak")
		leaky.bindExtensionsImpl = async () => {
			throw new Error("bind boom")
		}
		const factory: AcpSessionFactory = async () => asSession(leaky)
		const localAgent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})

		await expect(localAgent.newSession({ cwd: "/tmp", mcpServers: [] })).rejects.toThrow(/bind boom/)
		expect(leaky.disposed).toBe(true)
		expect(getAcpPrompter("session-bind-leak")).toBeUndefined()
	})

	it("registers an ACP permission prompter that maps allow_once through requestPermission", async () => {
		const requests: RequestPermissionRequest[] = []
		const conn = {
			sessionUpdate: async (_p: SessionNotification) => {},
			requestPermission: async (params: RequestPermissionRequest) => {
				requests.push(params)
				return { outcome: { outcome: "selected", optionId: "choice-0" } }
			},
		} as unknown as AgentSideConnection
		const localFake = new FakeAgentSession("session-permission")
		const localAgent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(localFake),
		})
		await localAgent.newSession({ cwd: "/tmp", mcpServers: [] })

		const prompter = getAcpPrompter("session-permission")
		expect(prompter).toBeDefined()
		const result = await prompter?.request({
			toolCallId: "tc-permission",
			toolName: "bash",
			input: { command: "touch allowed.txt" },
			choices: [
				{ kind: "allow-once", label: "Allow once" },
				{ kind: "deny", label: "Deny" },
			],
		})

		expect(result).toEqual({ kind: "allow-once" })
		expect(requests).toHaveLength(1)
		expect(requests[0]).toMatchObject({
			sessionId: "session-permission",
			toolCall: {
				toolCallId: "kt.bash.0",
				title: "touch allowed.txt",
				kind: "execute",
				status: "pending",
				rawInput: { command: "touch allowed.txt" },
				_meta: { piToolCallId: "tc-permission" },
			},
			options: [
				{ optionId: "choice-0", name: "Allow once", kind: "allow_once" },
				{ optionId: "choice-1", name: "Deny", kind: "reject_once" },
			],
		})
		expect(requests[0].toolCall).not.toHaveProperty("sessionUpdate")

		await localAgent.shutdown()
		expect(getAcpPrompter("session-permission")).toBeUndefined()
	})

	it("maps ACP permission cancellation to an aborted prompt result", async () => {
		const requests: RequestPermissionRequest[] = []
		const conn = {
			sessionUpdate: async (_p: SessionNotification) => {},
			requestPermission: async (params: RequestPermissionRequest) => {
				requests.push(params)
				return {
					outcome: { outcome: "cancelled" },
				}
			},
		} as unknown as AgentSideConnection
		const localFake = new FakeAgentSession("session-permission-cancel")
		const localAgent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(localFake),
		})
		await localAgent.newSession({ cwd: "/tmp", mcpServers: [] })

		const prompter = getAcpPrompter("session-permission-cancel")
		const result = await prompter?.request({
			toolCallId: "tc-cancel",
			toolName: "write",
			input: { path: "/tmp/out.txt", content: "x" },
			choices: [{ kind: "allow-once", label: "Allow once" }],
		})

		expect(result).toEqual({ kind: "aborted" })
		expect(requests).toHaveLength(1)

		const abort = new AbortController()
		abort.abort()
		const skippedResult = await prompter?.request({
			toolCallId: "tc-cancel-retry",
			toolName: "write",
			input: { path: "/tmp/out.txt", content: "x" },
			choices: [{ kind: "allow-once", label: "Allow once" }],
			signal: abort.signal,
		})

		expect(skippedResult).toEqual({ kind: "aborted" })
		expect(requests).toHaveLength(1)
		await localAgent.shutdown()
	})

	it("closes a live session and unregisters its ACP permission prompter", async () => {
		expect(getAcpPrompter(sessionId)).toBeDefined()

		await agent.unstable_closeSession({ sessionId })

		expect(fake.disposed).toBe(true)
		expect(getAcpPrompter(sessionId)).toBeUndefined()
		await expect(
			agent.prompt({
				sessionId,
				prompt: [{ type: "text", text: "hello" }],
			}),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("cancels an in-flight turn when closing a session", async () => {
		let releasePrompt!: () => void
		const promptReleased = new Promise<void>((resolve) => {
			releasePrompt = resolve
		})
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			await promptReleased
		}

		const result = agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "hello" }],
		})
		await delay(0)
		await agent.unstable_closeSession({ sessionId })
		releasePrompt()

		await expect(result).resolves.toEqual({ stopReason: "cancelled" })
		expect(fake.aborted).toBe(true)
		expect(fake.disposed).toBe(true)
	})

	it("keeps a same-id reload isolated while close awaits abort", async () => {
		const sid = "session-close-reload"
		const oldFake = new FakeAgentSession(sid)
		const newFake = new FakeAgentSession(sid)
		const { conn, updates } = makeRecordingConn()
		let loaderCalls = 0
		let releaseOldPrompt!: () => void
		const oldPromptReleased = new Promise<void>((resolve) => {
			releaseOldPrompt = resolve
		})
		let releaseNewPrompt!: () => void
		const newPromptReleased = new Promise<void>((resolve) => {
			releaseNewPrompt = resolve
		})
		let markNewPromptStarted!: () => void
		const newPromptStarted = new Promise<void>((resolve) => {
			markNewPromptStarted = resolve
		})
		let newPrompt: Promise<unknown> | undefined
		const localAgent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(oldFake),
			sessionLoader: async () => {
				loaderCalls++
				return asSession(newFake)
			},
		})

		oldFake.promptImpl = async () => {
			oldFake.emit({ type: "agent_start" })
			await oldPromptReleased
		}
		newFake.promptImpl = async () => {
			newFake.emit({ type: "agent_start" })
			markNewPromptStarted()
			await newPromptReleased
			newFake.emit(agentEnd())
		}
		oldFake.abortImpl = async () => {
			await localAgent.loadSession({
				sessionId: sid,
				cwd: "/tmp",
				mcpServers: [],
			})
			newPrompt = localAgent.prompt({
				sessionId: sid,
				prompt: [{ type: "text", text: "new turn" }],
			})
			await newPromptStarted
			oldFake.emit({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "stale old event" },
			} as unknown as AgentSessionEvent)
			releaseNewPrompt()
		}

		await localAgent.newSession({ cwd: "/tmp", mcpServers: [] })
		const oldPrompt = localAgent.prompt({
			sessionId: sid,
			prompt: [{ type: "text", text: "old turn" }],
		})
		await delay(0)

		await localAgent.unstable_closeSession({ sessionId: sid })
		releaseOldPrompt()

		await expect(oldPrompt).resolves.toEqual({ stopReason: "cancelled" })
		await expect(newPrompt).resolves.toEqual({ stopReason: "end_turn" })
		expect(loaderCalls).toBe(1)
		expect(getAcpPrompter(sid)).toBeDefined()
		expect(
			updates.some(
				(u) =>
					u.update.sessionUpdate === "agent_message_chunk" &&
					(u.update as { content: { text: string } }).content.text === "stale old event",
			),
		).toBe(false)

		await localAgent.shutdown()
	})

	// mcpServers is declared in the ACP request shape but kimchi has no hook to
	// wire them into a live session — pi-coding-agent loads MCP servers from its
	// own config. Silently dropping them would leave the client believing those
	// servers are available; reject up-front with invalidParams instead.
	it("rejects newSession when mcpServers is non-empty", async () => {
		const factoryCalled = { count: 0 }
		const factory: AcpSessionFactory = async () => {
			factoryCalled.count++
			return asSession(new FakeAgentSession("unused"))
		}
		const localAgent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await expect(
			localAgent.newSession({
				cwd: "/tmp",
				// biome-ignore lint/suspicious/noExplicitAny: only the shape we care about
				mcpServers: [{ name: "x", command: "x", args: [] } as any],
			}),
		).rejects.toMatchObject({ code: -32602 })
		expect(factoryCalled.count).toBe(0)
	})

	// Empty array is fine — equivalent to "no per-session servers requested".
	it("accepts newSession with empty mcpServers array", async () => {
		const localFake = new FakeAgentSession("empty-mcp")
		const factory: AcpSessionFactory = async () => asSession(localFake)
		const localAgent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		const res = await localAgent.newSession({ cwd: "/tmp", mcpServers: [] })
		expect(res.sessionId).toBe("empty-mcp")
	})

	// If the factory itself throws (e.g. bindExtensions failure in the default
	// factory), newSession must propagate the error — the factory owns disposal
	// of anything it allocated before throwing.
	it("propagates errors thrown by the session factory", async () => {
		const throwing: AcpSessionFactory = async () => {
			throw new Error("factory refused")
		}
		const localAgent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: throwing,
		})

		await expect(localAgent.newSession({ cwd: "/tmp", mcpServers: [] })).rejects.toThrow(/factory refused/)
	})

	// Two sessions run prompts concurrently; each turn must finalize against
	// its own agent_end. The slower session must not block the faster one.
	it("isolates turn state across parallel sessions", async () => {
		const fakeA = new FakeAgentSession("session-a")
		const fakeB = new FakeAgentSession("session-b")
		const fakes = [fakeA, fakeB]
		let i = 0
		const rotating: AcpSessionFactory = async () => asSession(fakes[i++] ?? fakes[fakes.length - 1])
		const parallelAgent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: rotating,
		})
		const a = await parallelAgent.newSession({ cwd: "/tmp/a", mcpServers: [] })
		const b = await parallelAgent.newSession({ cwd: "/tmp/b", mcpServers: [] })
		expect(a.sessionId).not.toBe(b.sessionId)

		fakeA.promptImpl = async () => {
			fakeA.emit({ type: "agent_start" })
			await delay(5)
			setTimeout(() => fakeA.emit(agentEnd()), 60)
		}
		fakeB.promptImpl = async () => {
			fakeB.emit({ type: "agent_start" })
			await delay(5)
			setTimeout(() => fakeB.emit(agentEnd()), 10)
		}

		const [resA, resB] = await Promise.all([
			parallelAgent.prompt({
				sessionId: a.sessionId,
				prompt: [{ type: "text", text: "a" }],
			}),
			parallelAgent.prompt({
				sessionId: b.sessionId,
				prompt: [{ type: "text", text: "b" }],
			}),
		])
		expect(resA.stopReason).toBe("end_turn")
		expect(resB.stopReason).toBe("end_turn")
	})
})

// Usage reporting (issue #03): the ACP server accumulates pi-ai Usage across
// pi-mono's chained prompt/continue calls — each chain step emits its own
// assistant message_end with its own usage object — folds the sum into the
// (experimental) PromptResponse.usage, and pairs assistant message_end
// events with usage_update sessionUpdates mapped from
// session.getContextUsage(). Both pieces are gated: PromptResponse.usage is
// omitted when the turn collected no usage, and usage_update is skipped when
// the estimate is undefined or its token count is null (post-compaction).
describe("KimchiAcpAgent usage reporting", () => {
	let fake: FakeAgentSession
	let agent: KimchiAcpAgent
	let sessionId: string
	let updates: SessionNotification[]

	beforeEach(async () => {
		fake = new FakeAgentSession("session-usage")
		const { conn, updates: rec } = makeRecordingConn()
		updates = rec
		agent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})
		const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		sessionId = res.sessionId
	})

	const usageUpdates = () => updates.filter((u) => u.update.sessionUpdate === "usage_update")

	// Builds the assistant message_end event pi-mono emits after an LLM
	// response. totalTokens is computed the way providers do (pi-ai 0.84
	// Usage docs): input + output + cacheRead + cacheWrite, where `reasoning`
	// is a subset of `output` and must never be re-added.
	function assistantUsageEvent(usage: {
		input: number
		output: number
		cacheRead?: number
		cacheWrite?: number
		reasoning?: number
	}): AgentSessionEvent {
		const cacheRead = usage.cacheRead ?? 0
		const cacheWrite = usage.cacheWrite ?? 0
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead,
				cacheWrite,
				...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
				totalTokens: usage.input + usage.output + cacheRead + cacheWrite,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		}
		return { type: "message_end", message }
	}

	it("sums pi-ai usage across chained assistant messages into PromptResponse.usage", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit(assistantUsageEvent({ input: 100, output: 20, cacheRead: 5, cacheWrite: 3, reasoning: 7 }))
			// Second chain step (e.g. agent.continue after a tool call or follow-up).
			fake.emit(assistantUsageEvent({ input: 50, output: 10, cacheRead: 2, cacheWrite: 1, reasoning: 3 }))
			fake.emit(agentEnd())
		}

		const result = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })

		expect(result.stopReason).toBe("end_turn")
		expect(result.usage).toEqual({
			inputTokens: 150,
			outputTokens: 30,
			cachedReadTokens: 7,
			cachedWriteTokens: 4,
			thoughtTokens: 10,
			// msg1: 100+20+5+3=128, msg2: 50+10+2+1=63 — reasoning (7, 3) is a
			// subset of output and must not be double-counted.
			totalTokens: 191,
		})
	})

	it("omits thoughtTokens when no provider reported a reasoning count", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit(assistantUsageEvent({ input: 100, output: 20 }))
			fake.emit(agentEnd())
		}

		const result = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })

		expect(result.usage?.inputTokens).toBe(100)
		expect(result.usage?.outputTokens).toBe(20)
		expect(result.usage).not.toHaveProperty("thoughtTokens")
	})

	it("emits usage_update with size/used on assistant message_end and again at turn end", async () => {
		fake.contextUsage = { tokens: 1234, contextWindow: 200000, percent: 0.617 }
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit(assistantUsageEvent({ input: 100, output: 20 }))
			fake.emit(agentEnd())
		}

		const result = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })

		const usage = usageUpdates()
		// One live update on the assistant message_end, one final update at
		// finalizeTurn — both reflect the same getContextUsage() snapshot here.
		expect(usage).toHaveLength(2)
		expect(usage[0].sessionId).toBe(sessionId)
		expect(usage[1].sessionId).toBe(sessionId)
		for (const u of usage) {
			expect(u.update).toMatchObject({ sessionUpdate: "usage_update", size: 200000, used: 1234 })
		}
		// PromptResponse.usage is independent of the context-window estimate.
		expect(result.usage?.inputTokens).toBe(100)
	})

	it("refreshes the context indicator after each chained assistant message", async () => {
		fake.contextUsage = { tokens: 1234, contextWindow: 200000, percent: 0.617 }
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit(assistantUsageEvent({ input: 100, output: 20, cacheRead: 5, cacheWrite: 3 }))
			// Second chain step (e.g. agent.continue after a tool call).
			fake.emit(assistantUsageEvent({ input: 50, output: 10, cacheRead: 2, cacheWrite: 1 }))
			fake.emit(agentEnd())
		}

		await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })

		// One usage_update per assistant message_end (2), plus the final
		// turn-end emission — the indicator follows the turn live instead of
		// updating only once at the end.
		expect(usageUpdates()).toHaveLength(3)
	})

	it("skips usage_update when getContextUsage returns undefined", async () => {
		fake.contextUsage = undefined
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit(assistantUsageEvent({ input: 100, output: 20 }))
			fake.emit(agentEnd())
		}

		const result = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })

		expect(usageUpdates()).toHaveLength(0)
		// Per-turn summing must not depend on the context-window estimate.
		expect(result.usage?.inputTokens).toBe(100)
	})

	it("skips usage_update when the context estimate has null tokens (post-compaction)", async () => {
		fake.contextUsage = { tokens: null, contextWindow: 200000, percent: null }
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit(assistantUsageEvent({ input: 100, output: 20 }))
			fake.emit(agentEnd())
		}

		await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })

		expect(usageUpdates()).toHaveLength(0)
	})

	it("never emits usage_update during streaming (message_update deltas)", async () => {
		fake.contextUsage = { tokens: 500, contextWindow: 200000, percent: 0.25 }
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "streaming ",
					contentIndex: 0,
					partial: {} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "text",
					contentIndex: 0,
					partial: {} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit(agentEnd())
		}

		const result = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })

		// Streaming chunks arrived, but no assistant message_end with usage
		// ever fired, so PromptResponse.usage is undefined. Exactly one
		// usage_update fires — the final emitUsageUpdate at turn end
		// (contextUsage is set); none in response to the deltas themselves.
		expect(updates.some((u) => u.update.sessionUpdate === "agent_message_chunk")).toBe(true)
		expect(result.usage).toBeUndefined()
		expect(usageUpdates()).toHaveLength(1)
	})

	it("omits PromptResponse.usage when the turn is cancelled before any assistant message", async () => {
		let cancelSeen = false
		fake.promptImpl = async () => {
			// Wait until cancel() runs so the turn context is marked cancelled
			// before promptImpl resolves.
			while (!cancelSeen) await delay(5)
		}
		fake.abortImpl = async () => {
			cancelSeen = true
		}

		const pending = agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })
		await delay(10)
		await agent.cancel({ sessionId })
		const result = await pending

		expect(result.stopReason).toBe("cancelled")
		expect(result.usage).toBeUndefined()
	})
})

// ACP ContentChunk contract (src/modes/acp/server.ts onSessionEvent):
// "All chunks belonging to the same message share the same messageId.
// A change in messageId indicates a new message has started." pi-mono
// streams one text_delta / thinking_delta event per chunk, but every delta
// within a content block shares its contentIndex — so the server can collapse
// them onto a single messageId without coordinating across events. The block
// below exercises both branches directly so a regression that drops the field
// or breaks its stability surfaces as a test failure rather than a quiet
// client-side bug.
describe("KimchiAcpAgent messageId on streaming chunks", () => {
	let fake: FakeAgentSession
	let agent: KimchiAcpAgent
	let sessionId: string
	let updates: SessionNotification[]

	beforeEach(async () => {
		fake = new FakeAgentSession("session-msgid")
		const rec = makeRecordingConn()
		updates = rec.updates
		agent = new KimchiAcpAgent(rec.conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})
		const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		sessionId = res.sessionId
	})

	function emitTextDeltas(contentIndex: number, deltas: string[]): void {
		for (const delta of deltas) {
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta,
					contentIndex,
					partial: {} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
		}
	}

	function emitThinkingDeltas(contentIndex: number, deltas: string[]): void {
		for (const delta of deltas) {
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					delta,
					contentIndex,
					partial: {} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
		}
	}

	function messageIdsFor(update: string): Array<string | null | undefined> {
		return updates
			.filter((u) => u.update.sessionUpdate === update)
			.map((u) => (u.update as { messageId?: string | null }).messageId)
	}

	it("keeps messageId stable across deltas within a block and flips it when contentIndex advances", async () => {
		// Two text blocks back-to-back. The first three deltas share index 0
		// (one messageId); the next three share index 1 (a different one).
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			emitTextDeltas(0, ["a", "b", "c"])
			emitTextDeltas(1, ["d", "e", "f"])
			fake.emit(agentEnd())
		}
		const result = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "two blocks" }],
		})
		expect(result.stopReason).toBe("end_turn")
		expect(messageIdsFor("agent_message_chunk")).toEqual(["km.0", "km.0", "km.0", "km.1", "km.1", "km.1"])
	})

	it("emits messageId on agent_thought_chunk the same way (same contentIndex → same id)", async () => {
		// Smoke test for the thought branch: the formula is identical to the
		// text branch, so a regression that drops the field on either side
		// surfaces in at least one of the two tests.
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			emitThinkingDeltas(0, ["hmm", " ", "ok"])
			fake.emit(agentEnd())
		}
		const result = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "think" }],
		})
		expect(result.stopReason).toBe("end_turn")
		expect(messageIdsFor("agent_thought_chunk")).toEqual(["km.0", "km.0", "km.0"])
	})

	it("advances the counter across turns so two turns both starting at contentIndex=0 get distinct ids", async () => {
		// Regression guard for the ACP "change in messageId indicates a new
		// message" contract. pi-mono resets contentIndex to 0 on each new
		// assistant message; without a session-wide counter, turn 2's first
		// block would re-use turn 1's first block's messageId and a client
		// would merge two separate replies into one bubble.
		fake.promptImpl = async () => {
			// Turn 1: one text block at index 0.
			fake.emit({ type: "agent_start" })
			emitTextDeltas(0, ["hello"])
			fake.emit(agentEnd())
			// Turn 2 (chained continue): another text block at index 0 again.
			// contentIndex resets per assistant message, but the session-wide
			// counter must keep advancing.
			fake.emit({ type: "agent_start" })
			emitTextDeltas(0, ["world"])
			fake.emit(agentEnd())
		}
		const result = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "two turns" }],
		})
		expect(result.stopReason).toBe("end_turn")
		expect(messageIdsFor("agent_message_chunk")).toEqual(["km.0", "km.1"])
	})
})

// Streaming tools (bash in particular) emit tool_execution_update with a
// partialResult payload for every output chunk. The ACP server translates each
// of these into a tool_call_update with status="in_progress" and content carrying
// the partial output — distinct from the terminal completed/failed update that
// accompanies tool_execution_end. The block below covers that branch directly.
describe("KimchiAcpAgent tool execution stream", () => {
	let fake: FakeAgentSession
	let agent: KimchiAcpAgent
	let sessionId: string
	let updates: SessionNotification[]

	beforeEach(async () => {
		fake = new FakeAgentSession("session-tool")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const rec = makeRecordingConn()
		updates = rec.updates
		agent = new KimchiAcpAgent(rec.conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})
		const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		sessionId = res.sessionId
	})

	it("forwards partial tool_execution_update events as in_progress tool_call_update notifications with content", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-1",
				toolName: "bash",
				args: { command: "printf a; sleep 0; printf b" },
			})
			fake.emit({
				type: "tool_execution_update",
				toolCallId: "tc-1",
				toolName: "bash",
				args: { command: "printf a; sleep 0; printf b" },
				partialResult: { content: [{ type: "text", text: "a" }] },
			})
			fake.emit({
				type: "tool_execution_update",
				toolCallId: "tc-1",
				toolName: "bash",
				args: { command: "printf a; sleep 0; printf b" },
				partialResult: { content: [{ type: "text", text: "ab" }] },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "ab" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")

		const toolCallUpdates = updates.filter((u) => u.update.sessionUpdate === "tool_call_update")
		const partials = toolCallUpdates.filter((u) => {
			const up = u.update as { status?: string; content?: unknown[] }
			return up.status === "in_progress" && Array.isArray(up.content) && up.content.length > 0
		})
		expect(partials).toHaveLength(2)
		// Each partial must carry the agent_session partialResult content verbatim
		// as ACP tool_call content blocks — proving the partialResult -> content
		// translation (toolResultContent) ran on the stream path, not only at end.
		const firstContent = (partials[0].update as { content: Array<{ content: { text: string } }> }).content
		expect(firstContent[0].content.text).toBe("a")
		const secondContent = (partials[1].update as { content: Array<{ content: { text: string } }> }).content
		expect(secondContent[0].content.text).toBe("ab")

		// Terminal completed update still fires after the partials.
		const terminal = toolCallUpdates.find((u) => (u.update as { status?: string }).status === "completed")
		expect(terminal).toBeDefined()
	})

	// web_fetch (and MCP image tools whose blocks survive transformMcpContent)
	// can return image blocks in a tool result. toolResultContent must forward
	// them as ACP image content; before this they were dropped and the client
	// saw a completed tool call with empty content.
	it("forwards an image block on tool_execution_end as ACP image content", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-img",
				toolName: "web_fetch",
				args: { url: "x" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-img",
				toolName: "web_fetch",
				result: {
					content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				},
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")

		const completed = updates.find(
			(u) => u.update.sessionUpdate === "tool_call_update" && (u.update as { status?: string }).status === "completed",
		)
		expect(completed).toBeDefined()
		const content = (completed?.update as { content: unknown[] }).content
		expect(content).toEqual([
			{
				type: "content",
				content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			},
		])
	})

	// The image path also runs on the streaming branch: an image-only partial
	// must produce an in_progress update rather than being swallowed as empty.
	it("forwards image blocks from a streaming partialResult", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-img2",
				toolName: "web_fetch",
				args: { url: "x" },
			})
			fake.emit({
				type: "tool_execution_update",
				toolCallId: "tc-img2",
				toolName: "web_fetch",
				args: { url: "x" },
				partialResult: {
					content: [{ type: "image", data: "Zm9v", mimeType: "image/jpeg" }],
				},
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-img2",
				toolName: "web_fetch",
				result: {
					content: [{ type: "image", data: "Zm9v", mimeType: "image/jpeg" }],
				},
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")

		const partial = updates.find(
			(u) =>
				u.update.sessionUpdate === "tool_call_update" && (u.update as { status?: string }).status === "in_progress",
		)
		expect(partial).toBeDefined()
		const content = (partial?.update as { content: unknown[] }).content
		expect(content).toEqual([
			{
				type: "content",
				content: { type: "image", data: "Zm9v", mimeType: "image/jpeg" },
			},
		])
	})

	// A result mixing text and image blocks forwards every block, in order.
	it("forwards text and image blocks together, preserving order", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-mix",
				toolName: "web_fetch",
				args: { url: "x" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-mix",
				toolName: "web_fetch",
				result: {
					content: [
						{ type: "text", text: "before" },
						{ type: "image", data: "YmFy", mimeType: "image/png" },
					],
				},
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")

		const completed = updates.find(
			(u) => u.update.sessionUpdate === "tool_call_update" && (u.update as { status?: string }).status === "completed",
		)
		const content = (completed?.update as { content: unknown[] }).content
		expect(content).toEqual([
			{ type: "content", content: { type: "text", text: "before" } },
			{
				type: "content",
				content: { type: "image", data: "YmFy", mimeType: "image/png" },
			},
		])
	})

	// Guard on server.ts:213-214: an empty partialResult must NOT produce a
	// tool_call_update — an in_progress update with empty content is noise for
	// clients that render the stream as it arrives.
	it("skips tool_execution_update events whose partialResult carries no content", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-2",
				toolName: "bash",
				args: { command: "true" },
			})
			// Empty partial shapes we can plausibly see: null, undefined, missing content, empty array.
			fake.emit({
				type: "tool_execution_update",
				toolCallId: "tc-2",
				toolName: "bash",
				args: { command: "true" },
				partialResult: null,
			})
			fake.emit({
				type: "tool_execution_update",
				toolCallId: "tc-2",
				toolName: "bash",
				args: { command: "true" },
				partialResult: { content: [] },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-2",
				toolName: "bash",
				result: { content: [{ type: "text", text: "" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")

		const toolCallUpdates = updates.filter((u) => u.update.sessionUpdate === "tool_call_update")
		const partials = toolCallUpdates.filter((u) => (u.update as { status?: string }).status === "in_progress")
		expect(partials).toHaveLength(0)
		// Terminal completed update still present.
		const terminal = toolCallUpdates.find((u) => (u.update as { status?: string }).status === "completed")
		expect(terminal).toBeDefined()
	})

	it("suppresses ACP tool notifications for system Agent tool calls", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-system-agent",
				toolName: "Agent",
				args: {
					prompt: "classify",
					description: "permission classifier",
					visibility: "system",
				},
			})
			fake.emit({
				type: "tool_execution_update",
				toolCallId: "tc-system-agent",
				toolName: "Agent",
				args: {
					prompt: "classify",
					description: "permission classifier",
					visibility: "system",
				},
				partialResult: {
					content: [{ type: "text", text: "System agent started." }],
				},
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-system-agent",
				toolName: "Agent",
				result: { content: [{ type: "text", text: "System agent started." }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")
		expect(updates.some((u) => u.update.sessionUpdate === "tool_call")).toBe(false)
		expect(updates.some((u) => u.update.sessionUpdate === "tool_call_update")).toBe(false)
	})

	it("suppresses system Agent updates even if an update arrives before the start event", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_update",
				toolCallId: "tc-system-agent-update-first",
				toolName: "Agent",
				args: {
					prompt: "classify",
					description: "permission classifier",
					visibility: "system",
				},
				partialResult: {
					content: [{ type: "text", text: "System agent started." }],
				},
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-system-agent-update-first",
				toolName: "Agent",
				result: { content: [{ type: "text", text: "System agent started." }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")
		expect(updates.some((u) => u.update.sessionUpdate === "tool_call")).toBe(false)
		expect(updates.some((u) => u.update.sessionUpdate === "tool_call_update")).toBe(false)
	})

	it("rewrites upstream toolCallIds to session-unique ACP ids", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-1",
				toolName: "bash",
				args: { command: "echo a" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "a" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})

		const toolCalls = updates.filter((u) => u.update.sessionUpdate === "tool_call")
		const toolCallUpdates = updates.filter((u) => u.update.sessionUpdate === "tool_call_update")
		const acpId = (toolCalls[0].update as { toolCallId: string }).toolCallId
		expect(toolCalls).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					toolCallId: expect.stringMatching(/^kt\.bash\.\d+$/),
					_meta: { piToolCallId: "tc-1" },
				}),
			}),
		])
		expect(toolCallUpdates).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					toolCallId: acpId,
					_meta: { piToolCallId: "tc-1" },
				}),
			}),
		])
		// The upstream id must not leak to the ACP surface.
		expect(acpId).not.toBe("tc-1")
	})

	it("routes updates and end events to the allocated ACP toolCallId", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-partial",
				toolName: "bash",
				args: { command: "echo a" },
			})
			fake.emit({
				type: "tool_execution_update",
				toolCallId: "tc-partial",
				toolName: "bash",
				args: { command: "echo a" },
				partialResult: { content: [{ type: "text", text: "partial" }] },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-partial",
				toolName: "bash",
				result: { content: [{ type: "text", text: "final" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})

		const toolCalls = updates.filter((u) => u.update.sessionUpdate === "tool_call")
		const toolCallUpdates = updates.filter((u) => u.update.sessionUpdate === "tool_call_update")
		expect(toolCalls).toHaveLength(1)
		const acpId = (toolCalls[0].update as { toolCallId: string }).toolCallId
		expect(toolCalls[0]).toEqual(
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					toolCallId: acpId,
					_meta: { piToolCallId: "tc-partial" },
				}),
			}),
		)
		expect(toolCallUpdates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					update: expect.objectContaining({
						sessionUpdate: "tool_call_update",
						toolCallId: acpId,
						_meta: { piToolCallId: "tc-partial" },
					}),
				}),
			]),
		)
	})

	it("disambiguates a reused upstream toolCallId across compaction as two distinct calls", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-reused",
				toolName: "bash",
				args: { command: "echo first" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-reused",
				toolName: "bash",
				result: { content: [{ type: "text", text: "first" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})

		// Simulate compaction reusing the same upstream id for a new call.
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-reused",
				toolName: "bash",
				args: { command: "echo second" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-reused",
				toolName: "bash",
				result: { content: [{ type: "text", text: "second" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run again" }],
		})

		const calls = updates.filter((u) => u.update.sessionUpdate === "tool_call")
		expect(calls).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					toolCallId: expect.stringMatching(/^kt\.bash\.\d+$/),
					_meta: { piToolCallId: "tc-reused" },
				}),
			}),
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					toolCallId: expect.stringMatching(/^kt\.bash\.\d+$/),
					_meta: { piToolCallId: "tc-reused" },
				}),
			}),
		])
		const firstId = (calls[0].update as { toolCallId: string }).toolCallId
		const secondId = (calls[1].update as { toolCallId: string }).toolCallId
		expect(firstId).not.toBe(secondId)

		const firstUpdates = updates.filter(
			(u) =>
				u.update.sessionUpdate === "tool_call_update" && (u.update as { toolCallId: string }).toolCallId === firstId,
		)
		const secondUpdates = updates.filter(
			(u) =>
				u.update.sessionUpdate === "tool_call_update" && (u.update as { toolCallId: string }).toolCallId === secondId,
		)
		expect(firstUpdates).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					toolCallId: firstId,
					_meta: { piToolCallId: "tc-reused" },
				}),
			}),
		])
		expect(secondUpdates).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					toolCallId: secondId,
					_meta: { piToolCallId: "tc-reused" },
				}),
			}),
		])
	})

	it("disambiguates a reused upstream toolCallId within the same turn", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-reused",
				toolName: "bash",
				args: { command: "echo first" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-reused",
				toolName: "bash",
				result: { content: [{ type: "text", text: "first" }] },
				isError: false,
			})
			// Same upstream id reused immediately in the same turn.
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-reused",
				toolName: "bash",
				args: { command: "echo second" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-reused",
				toolName: "bash",
				result: { content: [{ type: "text", text: "second" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})

		const calls = updates.filter((u) => u.update.sessionUpdate === "tool_call")
		expect(calls).toHaveLength(2)
		const firstId = (calls[0].update as { toolCallId: string }).toolCallId
		const secondId = (calls[1].update as { toolCallId: string }).toolCallId
		expect(firstId).not.toBe(secondId)

		const firstUpdates = updates.filter(
			(u) => u.update.sessionUpdate === "tool_call_update" && u.update.toolCallId === firstId,
		)
		const secondUpdates = updates.filter(
			(u) => u.update.sessionUpdate === "tool_call_update" && u.update.toolCallId === secondId,
		)
		expect(firstUpdates).toHaveLength(1)
		expect(secondUpdates).toHaveLength(1)
	})

	// Chunk 1: toolcall_start must emit a tool_call notification with status="pending"
	// so clients can show progress while the model streams tool call arguments.
	// See spec-tool-call-streaming-harness.md.
	it("emits tool_call with status='pending' on toolcall_start", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					partial: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc-pending-1",
								name: "write",
								arguments: { file_path: "/tmp/test.txt" },
							},
						],
					} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")

		const toolCalls = updates.filter((u) => u.update.sessionUpdate === "tool_call")
		expect(toolCalls).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					toolCallId: expect.stringMatching(/^kt\.write\.\d+$/),
					status: "pending",
					title: expect.any(String),
					_meta: { piToolCallId: "tc-pending-1" },
				}),
			}),
		])
	})

	// toolcall_start → tool_execution_start must produce exactly ONE tool_call
	// (the pending one) plus a tool_call_update (in_progress), not two tool_calls.
	it("emits exactly one tool_call (pending) then tool_call_update (in_progress) when toolcall_start precedes tool_execution_start", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					partial: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc-flow-1",
								name: "bash",
								arguments: { command: "echo hi" },
							},
						],
					} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-flow-1",
				toolName: "bash",
				args: { command: "echo hi" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-flow-1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "hi\n" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")

		const toolCalls = updates.filter((u) => u.update.sessionUpdate === "tool_call")
		expect(toolCalls).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					toolCallId: expect.stringMatching(/^kt\.bash\.\d+$/),
					status: "pending",
					_meta: { piToolCallId: "tc-flow-1" },
				}),
			}),
		])
		const acpId = (toolCalls[0].update as { toolCallId: string }).toolCallId

		const toolCallUpdates = updates.filter((u) => u.update.sessionUpdate === "tool_call_update")
		expect(toolCallUpdates).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					toolCallId: acpId,
					status: "in_progress",
					_meta: { piToolCallId: "tc-flow-1" },
				}),
			}),
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					toolCallId: acpId,
					status: "completed",
					_meta: { piToolCallId: "tc-flow-1" },
				}),
			}),
		])
	})

	// Back-compat: providers that don't emit toolcall_start must still get the
	// original behavior — tool_execution_start alone emits tool_call (in_progress).
	it("emits tool_call with status='in_progress' when tool_execution_start fires without a prior toolcall_start", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-backcompat-1",
				toolName: "bash",
				args: { command: "echo backcompat" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-backcompat-1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "backcompat\n" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")

		const toolCalls = updates.filter((u) => u.update.sessionUpdate === "tool_call")
		expect(toolCalls).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					toolCallId: expect.stringMatching(/^kt\.bash\.\d+$/),
					status: "in_progress",
					_meta: { piToolCallId: "tc-backcompat-1" },
				}),
			}),
		])
		const acpId = (toolCalls[0].update as { toolCallId: string }).toolCallId

		const toolCallUpdates = updates.filter((u) => u.update.sessionUpdate === "tool_call_update")
		expect(toolCallUpdates).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					toolCallId: acpId,
					status: "completed",
					_meta: { piToolCallId: "tc-backcompat-1" },
				}),
			}),
		])
	})

	// Hidden tool calls (system Agent) must produce zero ACP events even when
	// toolcall_start fires — same suppression rule applies on both event types.
	it("emits no tool_call or tool_call_update when toolcall_start names a hidden tool", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					partial: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc-hidden-1",
								name: "Agent",
								arguments: { visibility: "system", prompt: "classify" },
							},
						],
					} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-hidden-1",
				toolName: "Agent",
				args: { visibility: "system", prompt: "classify" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-hidden-1",
				toolName: "Agent",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")
		expect(updates.some((u) => u.update.sessionUpdate === "tool_call")).toBe(false)
		expect(updates.some((u) => u.update.sessionUpdate === "tool_call_update")).toBe(false)
	})

	// Multiple concurrent tool calls — each toolCallId gets its own
	// pending → in_progress → completed sequence, no cross-contamination.
	it("emits a pending → in_progress → completed sequence per toolCallId across multiple tool calls", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					partial: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc-multi-a",
								name: "bash",
								arguments: { command: "echo a" },
							},
						],
					} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 1,
					partial: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc-multi-a",
								name: "bash",
								arguments: { command: "echo a" },
							},
							{
								type: "toolCall",
								id: "tc-multi-b",
								name: "bash",
								arguments: { command: "echo b" },
							},
						],
					} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-multi-a",
				toolName: "bash",
				args: { command: "echo a" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-multi-a",
				toolName: "bash",
				result: { content: [{ type: "text", text: "a\n" }] },
				isError: false,
			})
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-multi-b",
				toolName: "bash",
				args: { command: "echo b" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-multi-b",
				toolName: "bash",
				result: { content: [{ type: "text", text: "b\n" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")

		const toolCalls = updates.filter((u) => u.update.sessionUpdate === "tool_call")
		expect(toolCalls).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					status: "pending",
					toolCallId: expect.stringMatching(/^kt\.bash\.\d+$/),
					_meta: { piToolCallId: "tc-multi-a" },
				}),
			}),
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					status: "pending",
					toolCallId: expect.stringMatching(/^kt\.bash\.\d+$/),
					_meta: { piToolCallId: "tc-multi-b" },
				}),
			}),
		])
		const acpA = (toolCalls[0].update as { toolCallId: string }).toolCallId
		const acpB = (toolCalls[1].update as { toolCallId: string }).toolCallId
		expect(acpA).not.toBe(acpB)

		const toolCallUpdates = updates.filter((u) => u.update.sessionUpdate === "tool_call_update")
		expect(toolCallUpdates).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					status: "in_progress",
					toolCallId: acpA,
					_meta: { piToolCallId: "tc-multi-a" },
				}),
			}),
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					status: "completed",
					toolCallId: acpA,
					_meta: { piToolCallId: "tc-multi-a" },
				}),
			}),
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					status: "in_progress",
					toolCallId: acpB,
					_meta: { piToolCallId: "tc-multi-b" },
				}),
			}),
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					status: "completed",
					toolCallId: acpB,
					_meta: { piToolCallId: "tc-multi-b" },
				}),
			}),
		])
	})

	// Helper to build a toolcall_delta message_update event with a given toolCallId,
	// name and partial arguments. Used by the incremental-delta streaming tests below.
	function makeToolcallDelta(toolCallId: string, name: string, args: Record<string, unknown>): AgentSessionEvent {
		return {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "irrelevant",
				partial: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: toolCallId,
							name,
							arguments: args,
						} as never,
					],
				} as unknown as AssistantMessage,
			},
			message: {} as unknown as AssistantMessage,
		}
	}

	// Verify each delta's rawOutput reflects only the new characters and
	// generatedChars is cumulative.
	it("emits correct incremental rawOutput for each toolcall_delta", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			// Announce the tool call
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					partial: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc-every-delta-1",
								name: "write",
								arguments: {},
							},
						],
					} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit(
				makeToolcallDelta("tc-every-delta-1", "write", {
					file_path: "/tmp/a.txt",
					content: "chunk1",
				}),
			)
			fake.emit(
				makeToolcallDelta("tc-every-delta-1", "write", {
					file_path: "/tmp/a.txt",
					content: "chunk1chunk2",
				}),
			)
			fake.emit(
				makeToolcallDelta("tc-every-delta-1", "write", {
					file_path: "/tmp/a.txt",
					content: "chunk1chunk2chunk3",
				}),
			)
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")

		const toolCalls = updates.filter((u) => u.update.sessionUpdate === "tool_call")
		expect(toolCalls).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					status: "pending",
					toolCallId: expect.stringMatching(/^kt\.write\.\d+$/),
					_meta: { piToolCallId: "tc-every-delta-1" },
				}),
			}),
		])
		const acpId = (toolCalls[0].update as { toolCallId: string }).toolCallId

		const pendingUpdates = updates.filter(
			(u) =>
				u.update.sessionUpdate === "tool_call_update" && u.update.status === "pending" && u.update.toolCallId === acpId,
		)
		expect(pendingUpdates).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					status: "pending",
					toolCallId: acpId,
					rawOutput: { delta: "chunk1" },
					_meta: { generatedChars: "chunk1".length, piToolCallId: "tc-every-delta-1" },
				}),
			}),
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					status: "pending",
					toolCallId: acpId,
					rawOutput: { delta: "chunk2" },
					_meta: { generatedChars: "chunk1chunk2".length, piToolCallId: "tc-every-delta-1" },
				}),
			}),
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					status: "pending",
					toolCallId: acpId,
					rawOutput: { delta: "chunk3" },
					_meta: { generatedChars: "chunk1chunk2chunk3".length, piToolCallId: "tc-every-delta-1" },
				}),
			}),
		])
	})

	// Spec test 3: deltas for a toolCallId that was never announced via
	// toolcall_start must produce ZERO tool_call_update notifications.
	it("skips toolcall_delta for tool calls that were not announced via toolcall_start", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			// No prior toolcall_start — tc-orphan-1 is not in announcedToolCallIds.
			fake.emit(makeToolcallDelta("tc-orphan-1", "bash", { command: "ls" }))
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")

		const pendingUpdates = updates.filter(
			(u) =>
				u.update.sessionUpdate === "tool_call_update" &&
				u.update.status === "pending" &&
				u.update.toolCallId === "tc-orphan-1",
		)
		expect(pendingUpdates).toHaveLength(0)
	})

	// Spec test 4: hidden tool calls (system Agent) must produce zero
	// tool_call_update notifications even when the delta stream is active.
	it("skips toolcall_delta for hidden (system) tool calls", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					partial: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc-hidden-delta-1",
								name: "Agent",
								arguments: { visibility: "system", prompt: "classify" },
							},
						],
					} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit(
				makeToolcallDelta("tc-hidden-delta-1", "Agent", {
					visibility: "system",
					prompt: "classify this request",
				}),
			)
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")

		// No tool_call (from toolcall_start) AND no tool_call_update (from delta).
		expect(updates.some((u) => u.update.sessionUpdate === "tool_call")).toBe(false)
		const pendingUpdates = updates.filter(
			(u) => u.update.sessionUpdate === "tool_call_update" && u.update.toolCallId === "tc-hidden-delta-1",
		)
		expect(pendingUpdates).toHaveLength(0)
	})

	// Spec test 5: empty arguments (`{}`) carry no useful content — the
	// handler must skip them rather than emit a rawInput={} update.
	it("skips toolcall_delta events whose arguments are still empty", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					partial: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc-empty-1",
								name: "write",
								arguments: {},
							},
						],
					} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit(makeToolcallDelta("tc-empty-1", "write", {}))
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run" }],
		})
		expect(res.stopReason).toBe("end_turn")

		const pendingUpdates = updates.filter(
			(u) => u.update.sessionUpdate === "tool_call_update" && u.update.toolCallId === "tc-empty-1",
		)
		expect(pendingUpdates).toHaveLength(0)
	})

	it("extracts the correct content field for write and edit tool calls", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			// write tool — content field
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					partial: {
						role: "assistant",
						content: [{ type: "toolCall", id: "tc-write-1", name: "write", arguments: {} }],
					} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit(makeToolcallDelta("tc-write-1", "write", { content: "hello world" }))
			// edit tool — newText field
			fake.emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 1,
					partial: {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "tc-write-1", name: "write", arguments: {} },
							{ type: "toolCall", id: "tc-edit-1", name: "edit", arguments: {} },
						],
					} as unknown as AssistantMessage,
				},
				message: {} as unknown as AssistantMessage,
			})
			fake.emit(makeToolcallDelta("tc-edit-1", "edit", { newText: "abc" }))
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "run" }] })
		expect(res.stopReason).toBe("end_turn")

		const toolCalls = updates.filter((u) => u.update.sessionUpdate === "tool_call")
		expect(toolCalls).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					status: "pending",
					toolCallId: expect.stringMatching(/^kt\.write\.\d+$/),
					_meta: { piToolCallId: "tc-write-1" },
				}),
			}),
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					status: "pending",
					toolCallId: expect.stringMatching(/^kt\.edit\.\d+$/),
					_meta: { piToolCallId: "tc-edit-1" },
				}),
			}),
		])
		const writeAcpId = (toolCalls[0].update as { toolCallId: string }).toolCallId
		const editAcpId = (toolCalls[1].update as { toolCallId: string }).toolCallId

		const toolCallUpdates = updates.filter((u) => u.update.sessionUpdate === "tool_call_update")
		expect(toolCallUpdates).toEqual([
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					status: "pending",
					toolCallId: writeAcpId,
					rawOutput: { delta: "hello world" },
					_meta: { generatedChars: 11, piToolCallId: "tc-write-1" },
				}),
			}),
			expect.objectContaining({
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					status: "pending",
					toolCallId: editAcpId,
					rawOutput: { delta: "abc" },
					_meta: { generatedChars: 3, piToolCallId: "tc-edit-1" },
				}),
			}),
		])
	})
})

// Ticket #04 — Per-Turn Diffs. The edit and write tools carry the diff data in
// their own arguments (edit: args.edits[]; write: args.content + pre-write file
// content read at tool_execution_start). tool_execution_end for those tools
// must attach ACP `diff` content blocks to the terminal tool_call_update — in
// addition to the existing text/image content, never replacing it. Read-only
// tools emit no diffs. Args only travel on tool_execution_start, so the server
// captures FileChange data there and emits it at tool_execution_end.
describe("KimchiAcpAgent per-turn diffs", () => {
	let fake: FakeAgentSession
	let agent: KimchiAcpAgent
	let sessionId: string
	let updates: SessionNotification[]
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-acp-diff-"))
		fake = new FakeAgentSession("session-diff", tmpDir)
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const rec = makeRecordingConn()
		updates = rec.updates
		agent = new KimchiAcpAgent(rec.conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})
		const res = await agent.newSession({ cwd: tmpDir, mcpServers: [] })
		sessionId = res.sessionId
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	// Upstream toolCallIds are rewritten to session-unique ACP ids (kt.<tool>.N)
	// on the wire; the pi id survives in _meta.piToolCallId — key off that.
	const terminalContent = (piToolCallId: string): unknown[] => {
		const terminal = updates.find(
			(u) =>
				u.update.sessionUpdate === "tool_call_update" &&
				(u.update as { _meta?: { piToolCallId?: string } })._meta?.piToolCallId === piToolCallId &&
				((u.update as { status?: string }).status === "completed" ||
					(u.update as { status?: string }).status === "failed"),
		)
		expect(terminal).toBeDefined()
		return (terminal?.update as { content: unknown[] }).content
	}

	it("emits one diff content block for an edit tool call with a single edit", async () => {
		const target = join(tmpDir, "a.txt")
		writeFileSync(target, "hello world")
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-edit-1",
				toolName: "edit",
				args: { path: target, edits: [{ oldText: "hello", newText: "goodbye" }] },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-edit-1",
				toolName: "edit",
				result: { content: [{ type: "text", text: "Edited a.txt" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "do" }] })
		expect(res.stopReason).toBe("end_turn")

		// Existing text content preserved; the diff block is additional content.
		expect(terminalContent("tc-edit-1")).toEqual([
			{ type: "content", content: { type: "text", text: "Edited a.txt" } },
			{ type: "diff", path: target, oldText: "hello", newText: "goodbye" },
		])
	})

	// pi's edit tool accepts a legacy single-edit arg shape {path, oldText,
	// newText} (no edits array) and normalizes it internally. A legacy-shape
	// call must still emit its diff rather than silently producing none.
	it("emits a diff for an edit tool call using the legacy single-edit arg shape", async () => {
		const target = join(tmpDir, "legacy.txt")
		writeFileSync(target, "old text")
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-edit-legacy",
				toolName: "edit",
				args: { path: target, oldText: "old text", newText: "new text" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-edit-legacy",
				toolName: "edit",
				result: { content: [{ type: "text", text: "Edited legacy.txt" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "do" }] })
		expect(res.stopReason).toBe("end_turn")

		const content = terminalContent("tc-edit-legacy") as Array<{ type: string }>
		const diffs = content.filter((b) => b.type === "diff")
		expect(diffs).toEqual([{ type: "diff", path: target, oldText: "old text", newText: "new text" }])
	})

	it("emits one diff content block per edit for an edit tool call with multiple edits", async () => {
		const target = join(tmpDir, "multi.txt")
		writeFileSync(target, "one two")
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-edit-2",
				toolName: "edit",
				args: {
					path: target,
					edits: [
						{ oldText: "one", newText: "1" },
						{ oldText: "two", newText: "2" },
					],
				},
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-edit-2",
				toolName: "edit",
				result: { content: [{ type: "text", text: "Edited multi.txt" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "do" }] })
		expect(res.stopReason).toBe("end_turn")

		const content = terminalContent("tc-edit-2") as Array<{ type: string }>
		const diffs = content.filter((b) => b.type === "diff")
		expect(diffs).toEqual([
			{ type: "diff", path: target, oldText: "one", newText: "1" },
			{ type: "diff", path: target, oldText: "two", newText: "2" },
		])
		// Text content preserved alongside the diffs.
		expect(content.some((b) => b.type === "content")).toBe(true)
	})

	// Relative path exercises the server-side cwd resolution for the pre-write
	// read; the emitted diff path stays verbatim from args.path.
	it("emits a diff with oldText null for a write tool call creating a new file", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-write-new",
				toolName: "write",
				args: { path: "brand-new.txt", content: "fresh content" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-write-new",
				toolName: "write",
				result: { content: [{ type: "text", text: "Wrote brand-new.txt" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "do" }] })
		expect(res.stopReason).toBe("end_turn")

		const content = terminalContent("tc-write-new") as Array<{ type: string }>
		const diffs = content.filter((b) => b.type === "diff")
		expect(diffs).toEqual([{ type: "diff", path: "brand-new.txt", newText: "fresh content", oldText: null }])
	})

	// Overwrite: tool_execution_start must read the existing file into
	// TurnContext.preWriteContents so the diff carries it as oldText.
	it("emits a diff with the previous content as oldText for a write tool call overwriting a file", async () => {
		const target = join(tmpDir, "existing.txt")
		writeFileSync(target, "before content")
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-write-over",
				toolName: "write",
				args: { path: target, content: "after content" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-write-over",
				toolName: "write",
				result: { content: [{ type: "text", text: "Wrote existing.txt" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "do" }] })
		expect(res.stopReason).toBe("end_turn")

		const content = terminalContent("tc-write-over") as Array<{ type: string }>
		const diffs = content.filter((b) => b.type === "diff")
		expect(diffs).toEqual([{ type: "diff", path: target, oldText: "before content", newText: "after content" }])
	})

	// pi's write tool resolves args.path with stripAtPrefix +
	// normalizeUnicodeSpaces before touching disk. The pre-write read must
	// match that resolution or an overwrite of "@notes.txt" / "a b.txt" (typed
	// as "a\u00A0b.txt") would be misclassified as a new-file 'add'.
	it("resolves @-prefixed and unicode-space write paths for the pre-write read", async () => {
		const atTarget = join(tmpDir, "notes.txt")
		writeFileSync(atTarget, "at before")
		const spaceTarget = join(tmpDir, "my file.txt")
		writeFileSync(spaceTarget, "space before")
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-write-at",
				toolName: "write",
				args: { path: "@notes.txt", content: "at after" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-write-at",
				toolName: "write",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			})
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-write-nbsp",
				toolName: "write",
				// No-break space as typed by an LLM mimicking the on-disk name.
				args: { path: "my\u00A0file.txt", content: "space after" },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-write-nbsp",
				toolName: "write",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "do" }] })
		expect(res.stopReason).toBe("end_turn")

		// Emitted diff paths stay verbatim from args.path; only the pre-write
		// READ uses the normalized path.
		const atDiffs = (terminalContent("tc-write-at") as Array<{ type: string }>).filter((b) => b.type === "diff")
		expect(atDiffs).toEqual([{ type: "diff", path: "@notes.txt", oldText: "at before", newText: "at after" }])
		const nbspDiffs = (terminalContent("tc-write-nbsp") as Array<{ type: string }>).filter((b) => b.type === "diff")
		expect(nbspDiffs).toEqual([
			{ type: "diff", path: "my\u00A0file.txt", oldText: "space before", newText: "space after" },
		])
	})

	it("emits no diff content blocks for read-only tool calls", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			for (const [toolCallId, toolName, args] of [
				["tc-bash", "bash", { command: "true" }],
				["tc-read", "read", { path: join(tmpDir, "a.txt") }],
				["tc-grep", "grep", { pattern: "foo" }],
			] as const) {
				fake.emit({ type: "tool_execution_start", toolCallId, toolName, args })
				fake.emit({
					type: "tool_execution_end",
					toolCallId,
					toolName,
					result: { content: [{ type: "text", text: "ok" }] },
					isError: false,
				})
			}
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "do" }] })
		expect(res.stopReason).toBe("end_turn")

		for (const toolCallId of ["tc-bash", "tc-read", "tc-grep"]) {
			const content = terminalContent(toolCallId) as Array<{ type: string }>
			expect(content.some((b) => b.type === "diff")).toBe(false)
		}
	})

	// A failed mutation must not surface a diff — the client would otherwise
	// render a change that never landed.
	it("emits no diff content blocks when the edit/write tool call failed", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-edit-fail",
				toolName: "edit",
				args: { path: join(tmpDir, "a.txt"), edits: [{ oldText: "x", newText: "y" }] },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-edit-fail",
				toolName: "edit",
				result: { content: [{ type: "text", text: "boom" }] },
				isError: true,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "do" }] })
		expect(res.stopReason).toBe("end_turn")

		const content = terminalContent("tc-edit-fail") as Array<{ type: string }>
		expect(content.some((b) => b.type === "diff")).toBe(false)
	})
})

// Pure adapter coverage for the FileChange → v1 Diff mapping, including the
// delete branch the edit/write tools never produce today.
describe("fileChangeToDiffContent", () => {
	it("maps add to a diff with oldText null", () => {
		expect(fileChangeToDiffContent({ operation: "add", path: "/a.txt", newText: "new" })).toEqual({
			type: "diff",
			path: "/a.txt",
			newText: "new",
			oldText: null,
		})
	})

	it("maps modify to a diff carrying both texts", () => {
		expect(fileChangeToDiffContent({ operation: "modify", path: "/a.txt", oldText: "old", newText: "new" })).toEqual({
			type: "diff",
			path: "/a.txt",
			oldText: "old",
			newText: "new",
		})
	})

	it("maps delete to a diff omitting newText", () => {
		expect(fileChangeToDiffContent({ operation: "delete", path: "/a.txt", oldText: "gone" })).toEqual({
			type: "diff",
			path: "/a.txt",
			oldText: "gone",
		})
	})
})

// Coverage for assertSessionHasModel: ACP clients (Zed) should see authRequired
// (-32000), not a generic internal error, when the model is unavailable — that
// error code routes to the client's auth UI instead of an opaque failure toast.
describe("assertSessionHasModel", () => {
	it("throws RequestError with code -32000 when model is missing", () => {
		try {
			assertSessionHasModel({ model: undefined } as Parameters<typeof assertSessionHasModel>[0])
			throw new Error("expected throw")
		} catch (err) {
			expect((err as { code?: number }).code).toBe(-32000)
			expect((err as Error).message).toMatch(/No model available/)
		}
	})

	it("is a no-op when model is present", () => {
		expect(() =>
			assertSessionHasModel({
				model: {} as NonNullable<Parameters<typeof assertSessionHasModel>[0]["model"]>,
			}),
		).not.toThrow()
	})
})

describe("initializeHeadlessTheme", () => {
	beforeEach(() => {
		vi.stubGlobal(THEME_KEY, undefined)
		vi.stubGlobal(THEME_KEY_OLD, undefined)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("initializes pi's global theme proxy for headless sessions", () => {
		const globals = globalThis as Record<symbol, unknown>

		expect(globals[THEME_KEY]).toBeUndefined()
		expect(globals[THEME_KEY_OLD]).toBeUndefined()

		initializeHeadlessTheme({ getTheme: () => "default" })

		expect(globals[THEME_KEY]).toBeDefined()
		expect(globals[THEME_KEY_OLD]).toBeDefined()
		const initializedTheme = globals[THEME_KEY] as {
			getFgAnsi(color: string): string
		}
		expect(() => initializedTheme.getFgAnsi("accent")).not.toThrow()
	})
})

function modelConfigOption(
	currentValue: string,
	options: { value: string; name: string }[],
): {
	id: "model"
	name: string
	type: "select"
	category: string
	description: string
	currentValue: string
	options: { value: string; name: string }[]
} {
	return {
		id: "model",
		name: "Model",
		type: "select",
		category: "model",
		description: "",
		currentValue,
		options,
	}
}

describe("buildSessionModelState", () => {
	it("returns currentModelId and availableModels from the model config option", () => {
		const configOptions = [
			modelConfigOption("openai/gpt-4", [
				{ value: "anthropic/claude-3", name: "Claude 3" },
				{ value: "openai/gpt-4", name: "GPT-4" },
			]),
		]
		const result = buildSessionModelState(configOptions as unknown as Parameters<typeof buildSessionModelState>[0])
		expect(result).toEqual({
			currentModelId: "openai/gpt-4",
			availableModels: [
				{ modelId: "anthropic/claude-3", name: "Claude 3" },
				{ modelId: "openai/gpt-4", name: "GPT-4" },
			],
		})
	})

	it("returns empty availableModels when the model config option has no entries", () => {
		const configOptions = [modelConfigOption("openai/gpt-4", [])]
		const result = buildSessionModelState(configOptions as unknown as Parameters<typeof buildSessionModelState>[0])
		expect(result).toEqual({
			currentModelId: "openai/gpt-4",
			availableModels: [],
		})
	})
})

describe("newSession model state", () => {
	it("returns model state in the response when a model is available", async () => {
		const sessionId = "session-model"
		setProcessOrchestratorRef(sessionId, "kimchi-dev/kimi-k2.7")
		const fake = new FakeAgentSession(sessionId)
		fake.model = { provider: "openai", id: "gpt-4" }
		fake.modelRegistry = {
			...fake.modelRegistry,
			getAvailable: () => [
				{ provider: "openai", id: "gpt-4", name: "GPT-4" },
				{ provider: "anthropic", id: "claude-3", name: "Claude 3" },
			],
		}
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		expect(res.sessionId).toBe("session-model")
		expect(res.models).toBeDefined()
		expect(res.models?.currentModelId).toBe("openai/gpt-4")
		expect(res.models?.availableModels).toHaveLength(3)
		expect(res.models?.availableModels[0]).toEqual({
			modelId: "multi-model",
			name: "Multi-model (kimi-k2.7)",
		})
		expect(res.models?.availableModels[1]).toEqual({
			modelId: "anthropic/claude-3",
			name: "Claude 3",
		})
		expect(res.models?.availableModels[2]).toEqual({
			modelId: "openai/gpt-4",
			name: "GPT-4",
		})
	})

	it("rejects with authRequired when no model is active", async () => {
		const fake = new FakeAgentSession("session-empty")
		fake.model = undefined
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await expect(agent.newSession({ cwd: "/tmp", mcpServers: [] })).rejects.toMatchObject({ code: -32000 })
		expect(fake.disposed).toBe(true)
	})

	it("returns configOptions in newSession response", async () => {
		const fake = new FakeAgentSession("test-session-config")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})

		const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		expect(res.configOptions).toBeDefined()
		expect(res.configOptions).toHaveLength(2)
		expect(res.configOptions?.[0].id).toBe("permissions-mode")
		expect(res.configOptions?.[0].type).toBe("select")
		expect(res.configOptions?.[0].currentValue).toBeDefined()
		expect(res.configOptions?.[1].id).toBe("model")
		expect(res.configOptions?.[1].type).toBe("select")
	})
})

describe("newSession available commands", () => {
	it("sends available_commands_update with /bug command on session init", async () => {
		const fake = new FakeAgentSession("session-commands")
		const factory: AcpSessionFactory = async () => asSession(fake)
		const { conn, updates } = makeRecordingConn()
		const agent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		// Find the available_commands_update notification
		const update = updates.find((u) => u.update.sessionUpdate === "available_commands_update")
		expect(update).toBeDefined()
		expect(update?.sessionId).toBe("session-commands")

		const updatePayload = update?.update as {
			availableCommands: Array<Record<string, unknown>>
		}
		expect(updatePayload.availableCommands.length).toBeGreaterThanOrEqual(1)

		const cmd = updatePayload.availableCommands.find((c) => c.name === "bug")
		expect(cmd).toMatchObject({
			name: "bug",
			description: expect.any(String),
			input: { hint: expect.any(String) },
		})
	})
})

describe("loadSession available commands", () => {
	it("sends available_commands_update alongside the transcript replay", async () => {
		const fake = new FakeAgentSession("session-load-test")
		fake.branch = [userTextEntry("previous message", "u1", null)]
		const loader: AcpSessionLoader = async () => asSession(fake)
		const { conn, updates } = makeRecordingConn()
		const agent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(new FakeAgentSession("unused")),
			sessionLoader: loader,
		})

		await agent.loadSession({
			sessionId: "session-load-test",
			cwd: "/tmp",
			mcpServers: [],
		})

		// loadSessionFresh re-broadcasts the command palette on resume.
		const cmdUpdate = updates.find((u) => u.update.sessionUpdate === "available_commands_update")
		expect(cmdUpdate).toBeDefined()
		expect(updates.find((u) => u.update.sessionUpdate === "user_message_chunk")).toBeDefined()
	})
})

describe("newSession skill commands", () => {
	function makeSkillDir(): { dir: string; skillName: string; skill: Skill } {
		const dir = mkdtempSync(join(tmpdir(), "acp-server-skills-"))
		const skillName = "acp-test-skill"
		const skillDir = join(dir, ".pi", "agent", "skills", skillName)
		mkdirSync(skillDir, { recursive: true })
		const filePath = join(skillDir, "SKILL.md")
		writeFileSync(
			filePath,
			`---\nname: ${skillName}\ndescription: ACP test skill\n---\nAlways use strict types.`,
			"utf-8",
		)
		const skill = {
			name: skillName,
			description: "ACP test skill",
			filePath,
			baseDir: skillDir,
			sourceInfo: { source: "test", path: skillDir, scope: "user", origin: "top-level" },
		} as unknown as Skill
		return { dir, skillName, skill }
	}

	function makeSkillLoader(skills: Skill[]): ResourceLoader {
		return {
			getSkills: () => ({ skills, diagnostics: [] }),
			getExtensions: () => ({ extensions: [], errors: [], runtime: undefined }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {},
		} as unknown as ResourceLoader
	}

	it("advertises discovered skills as available commands", async () => {
		const { dir, skillName, skill } = makeSkillDir()
		const fake = new FakeAgentSession("session-skill-cmd", dir)
		fake.resourceLoader = makeSkillLoader([skill])
		const factory: AcpSessionFactory = async () => asSession(fake)
		const { conn, updates } = makeRecordingConn()
		const agent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await agent.newSession({ cwd: dir, mcpServers: [] })

		const update = updates.find((u) => u.update.sessionUpdate === "available_commands_update")
		expect(update).toBeDefined()
		const availableCommands = (update?.update as { availableCommands: Array<Record<string, unknown>> })
			.availableCommands
		const skillCmd = availableCommands.find((c) => c.name === `skill:${skillName}`)
		expect(skillCmd).toMatchObject({
			name: `skill:${skillName}`,
			description: "ACP test skill",
			input: { hint: expect.any(String) },
		})
	})

	it("rewrites a skill command prompt to inject skill content", async () => {
		const { dir, skillName, skill } = makeSkillDir()
		const fake = new FakeAgentSession("session-skill-invoke", dir)
		fake.resourceLoader = makeSkillLoader([skill])
		fake.promptImpl = async () => {
			fake.emit(agentEnd())
		}
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await agent.newSession({ cwd: dir, mcpServers: [] })

		await agent.prompt({
			sessionId: "session-skill-invoke",
			prompt: [{ type: "text", text: `/skill:${skillName} review this file` }],
		})

		expect(fake.promptCalls).toHaveLength(1)
		const sentPrompt = fake.promptCalls[0]?.prompt
		expect(sentPrompt).toContain("Invoking skill: acp-test-skill")
		expect(sentPrompt).toContain("Always use strict types.")
		expect(sentPrompt).toContain("review this file")
		expect(sentPrompt).not.toContain("description: ACP test skill")
		expect(sentPrompt).not.toContain("---")
	})

	it("leaves non-skill prompts unchanged", async () => {
		const { dir } = makeSkillDir()
		const fake = new FakeAgentSession("session-skill-pass-through", dir)
		fake.promptImpl = async () => {
			fake.emit(agentEnd())
		}
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await agent.newSession({ cwd: dir, mcpServers: [] })

		await agent.prompt({
			sessionId: "session-skill-pass-through",
			prompt: [{ type: "text", text: "hello world" }],
		})

		expect(fake.promptCalls).toHaveLength(1)
		expect(fake.promptCalls[0]?.prompt).toBe("hello world")
	})

	it("activates the Skill tool when it is registered", async () => {
		const { dir } = makeSkillDir()
		const fake = new FakeAgentSession("session-skill-tool", dir)
		fake.registeredTools.set("Skill", { name: "Skill" })
		fake.activeToolNames = ["read", "bash"]
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await agent.newSession({ cwd: dir, mcpServers: [] })

		expect(fake.activeToolNames).toContain("Skill")
		expect(fake.activeToolNames).toContain("read")
		expect(fake.activeToolNames).toContain("bash")
	})
})

describe("unstable_setSessionModel", () => {
	it("switches to a valid model", async () => {
		const fake = new FakeAgentSession("switch-session")
		fake.model = { provider: "provider-a", id: "model-a" }
		fake.modelRegistry = {
			...fake.modelRegistry,
			getAvailable: () => [
				{ provider: "provider-a", id: "model-a", name: "Model A" },
				{ provider: "provider-b", id: "model-b", name: "Model B" },
			],
		}
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		const res = await agent.unstable_setSessionModel({
			sessionId: "switch-session",
			modelId: "provider-b/model-b",
		})
		expect(res).toEqual({})
		expect(fake.model?.provider).toBe("provider-b")
		expect(fake.model?.id).toBe("model-b")
	})

	it("throws invalidParams for unknown modelId", async () => {
		const fake = new FakeAgentSession("switch-session")
		fake.model = { provider: "provider-a", id: "model-a" }
		fake.modelRegistry = {
			...fake.modelRegistry,
			getAvailable: () => [{ provider: "provider-a", id: "model-a", name: "Model A" }],
		}
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		await expect(
			agent.unstable_setSessionModel({
				sessionId: "switch-session",
				modelId: "unknown",
			}),
		).rejects.toThrow()
	})

	it("prompt still works after switching model", async () => {
		const fake = new FakeAgentSession("switch-session")
		fake.model = { provider: "provider-a", id: "model-a" }
		fake.modelRegistry = {
			...fake.modelRegistry,
			getAvailable: () => [
				{ provider: "provider-a", id: "model-a", name: "Model A" },
				{ provider: "provider-b", id: "model-b", name: "Model B" },
			],
		}
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		await agent.unstable_setSessionModel({
			sessionId: "switch-session",
			modelId: "provider-b/model-b",
		})
		const result = await agent.prompt({
			sessionId: "switch-session",
			prompt: [{ type: "text", text: "hello" }],
		})
		expect(result).toBeDefined()
		expect(fake.model?.provider).toBe("provider-b")
		expect(fake.model?.id).toBe("model-b")
	})

	it("throws invalidParams for unknown sessionId", async () => {
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
		})
		await expect(
			agent.unstable_setSessionModel({
				sessionId: "no-such-session",
				modelId: "model-a",
			}),
		).rejects.toThrow()
	})
})

describe("setSessionConfigOption", () => {
	it("sets permission mode via setSessionConfigOption and returns configOptions", async () => {
		const fake = new FakeAgentSession("test-session")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})

		const { sessionId } = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		})

		const res = await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "plan",
		})

		expect(res.configOptions).toHaveLength(2)
		expect(res.configOptions[0].id).toBe("permissions-mode")
		expect(res.configOptions[0].currentValue).toBe("plan")
		expect(res.configOptions[1].id).toBe("model")
	})

	it("sets all valid permission modes", async () => {
		const fake = new FakeAgentSession("test-session-modes")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})

		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		for (const mode of PERMISSION_MODES) {
			const res = await agent.setSessionConfigOption({
				sessionId: "test-session-modes",
				configId: "permissions-mode",
				value: mode,
			})
			expect(res.configOptions).toHaveLength(2)
			expect(res.configOptions[0].currentValue).toBe(mode)
			expect(res.configOptions[1].id).toBe("model")
		}
	})

	it("rejects invalid permission mode value", async () => {
		const fake = new FakeAgentSession("test-session-invalid")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})

		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		await expect(
			agent.setSessionConfigOption({
				sessionId: "test-session-invalid",
				configId: "permissions-mode",
				value: "invalid-mode",
			}),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("rejects unknown configId", async () => {
		const fake = new FakeAgentSession("test-session-unknown-config")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})

		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		await expect(
			agent.setSessionConfigOption({
				sessionId: "test-session-unknown-config",
				configId: "unknown-config",
				value: "plan",
			}),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("rejects unknown sessionId", async () => {
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
		})

		await expect(
			agent.setSessionConfigOption({
				sessionId: "no-such-session",
				configId: "permissions-mode",
				value: "plan",
			}),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("returns configOptions with correct structure", async () => {
		const fake = new FakeAgentSession("test-session-structure")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})

		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const res = await agent.setSessionConfigOption({
			sessionId: "test-session-structure",
			configId: "permissions-mode",
			value: "auto",
		})

		expect(res.configOptions[0]).toMatchObject({
			id: "permissions-mode",
			name: "Permissions Mode",
			type: "select",
			category: "mode",
			currentValue: "auto",
		})
		// Verify options array is present with all valid modes
		// biome-ignore lint/suspicious/noExplicitAny: union type requires assertion
		const selectOption = res.configOptions[0] as any
		expect(selectOption.options).toHaveLength(4)
		expect(selectOption.options.map((o: SelectOptionItem) => o.value)).toEqual(PERMISSION_MODES)
	})

	describe("model config option", () => {
		it("switches to a valid single model", async () => {
			const fake = new FakeAgentSession("test-session-model-single")
			fake.model = { provider: "provider-a", id: "model-a" }
			fake.modelRegistry = {
				...fake.modelRegistry,
				getAvailable: () => [
					{ provider: "provider-a", id: "model-a", name: "Model A" },
					{ provider: "provider-b", id: "model-b", name: "Model B" },
				],
			}
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: "/tmp/fake-agent-dir",
				sessionFactory: async () => asSession(fake),
			})
			await agent.newSession({ cwd: "/tmp", mcpServers: [] })

			const res = await agent.setSessionConfigOption({
				sessionId: "test-session-model-single",
				configId: "model",
				value: "provider-b/model-b",
			})

			expect(fake.model).toMatchObject({
				provider: "provider-b",
				id: "model-b",
			})
			const modelOption = res.configOptions?.find((o) => o.id === "model")
			expect(modelOption?.currentValue).toBe("provider-b/model-b")
		})

		it("restores previous multi-model state when switching to a single model fails", async () => {
			const sessionId = "test-session-model-restore"
			const fake = new FakeAgentSession(sessionId)
			fake.model = { provider: "provider-a", id: "model-a", name: "Model A" }
			fake.modelRegistry = {
				...fake.modelRegistry,
				getAvailable: () => [
					{ provider: "provider-a", id: "model-a", name: "Model A" },
					{ provider: "provider-b", id: "model-b", name: "Model B" },
				],
			}
			fake.setModel = async () => {
				throw new Error("auth failed")
			}
			// Start in multi-model mode so we can verify the flag is restored on failure.
			setMultiModelEnabled(sessionId, true)
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: "/tmp/fake-agent-dir",
				sessionFactory: async () => asSession(fake),
			})
			await agent.newSession({ cwd: "/tmp", mcpServers: [] })

			await expect(
				agent.setSessionConfigOption({
					sessionId,
					configId: "model",
					value: "provider-b/model-b",
				}),
			).rejects.toThrow(/model provider-b\/model-b is not available: auth required/)

			expect(getMultiModelEnabled(fake.sessionManager as Pick<SessionManager, "getEntries" | "getSessionId">)).toBe(
				true,
			)
		})

		it("switches to multi-model when orchestrator is available", async () => {
			const sessionId = "test-session-model-multi"
			const fake = new FakeAgentSession(sessionId)
			fake.model = { provider: "provider-a", id: "model-a", name: "Model A" }
			fake.modelRegistry = {
				...fake.modelRegistry,
				getAvailable: () => [
					{ provider: "provider-a", id: "model-a", name: "Model A" },
					{
						provider: "orchestrator-provider",
						id: "orchestrator-model",
						name: "Orchestrator Model",
					},
				],
			}
			// Wire the orchestrator model explicitly instead of relying on the global default role.
			setProcessOrchestratorRef(sessionId, "orchestrator-provider/orchestrator-model")
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: "/tmp/fake-agent-dir",
				sessionFactory: async () => asSession(fake),
			})
			await agent.newSession({ cwd: "/tmp", mcpServers: [] })

			const res = await agent.setSessionConfigOption({
				sessionId,
				configId: "model",
				value: "multi-model",
			})

			expect(fake.model).toMatchObject({
				provider: "orchestrator-provider",
				id: "orchestrator-model",
			})
			const modelOption = res.configOptions?.find((o) => o.id === "model")
			expect(modelOption?.currentValue).toBe("multi-model")
		})

		it("restores previous multi-model state when switching to multi-model fails", async () => {
			const sessionId = "test-session-model-multi-restore"
			const fake = new FakeAgentSession(sessionId)
			fake.model = { provider: "provider-a", id: "model-a", name: "Model A" }
			fake.modelRegistry = {
				...fake.modelRegistry,
				getAvailable: () => [
					{ provider: "provider-a", id: "model-a", name: "Model A" },
					{
						provider: "orchestrator-provider",
						id: "orchestrator-model",
						name: "Orchestrator Model",
					},
				],
			}
			fake.setModel = async () => {
				throw new Error("auth failed")
			}
			// Wire the orchestrator model explicitly instead of relying on the global default role.
			setProcessOrchestratorRef(sessionId, "orchestrator-provider/orchestrator-model")
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: "/tmp/fake-agent-dir",
				sessionFactory: async () => asSession(fake),
			})
			await agent.newSession({ cwd: "/tmp", mcpServers: [] })

			await expect(
				agent.setSessionConfigOption({
					sessionId,
					configId: "model",
					value: "multi-model",
				}),
			).rejects.toThrow(/orchestrator model orchestrator-provider\/orchestrator-model is not available: auth required/)

			expect(getMultiModelEnabled(fake.sessionManager as Pick<SessionManager, "getEntries" | "getSessionId">)).toBe(
				false,
			)
		})

		it("rejects multi-model when orchestrator is not available", async () => {
			const fake = new FakeAgentSession("test-session-model-multi-missing")
			fake.model = { provider: "provider-a", id: "model-a", name: "Model A" }
			fake.modelRegistry = {
				...fake.modelRegistry,
				getAvailable: () => [{ provider: "provider-a", id: "model-a", name: "Model A" }],
			}
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: "/tmp/fake-agent-dir",
				sessionFactory: async () => asSession(fake),
			})
			await agent.newSession({ cwd: "/tmp", mcpServers: [] })

			await expect(
				agent.setSessionConfigOption({
					sessionId: "test-session-model-multi-missing",
					configId: "model",
					value: "multi-model",
				}),
			).rejects.toThrow(/multi-model orchestrator .* is not available/)
		})

		it("rejects invalid model format", async () => {
			const fake = new FakeAgentSession("test-session-model-format")
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: "/tmp/fake-agent-dir",
				sessionFactory: async () => asSession(fake),
			})
			await agent.newSession({ cwd: "/tmp", mcpServers: [] })

			await expect(
				agent.setSessionConfigOption({
					sessionId: "test-session-model-format",
					configId: "model",
					value: "not-a-valid-ref",
				}),
			).rejects.toThrow(/invalid model format/)
		})

		it("rejects unknown single model", async () => {
			const fake = new FakeAgentSession("test-session-model-unknown")
			fake.model = { provider: "provider-a", id: "model-a", name: "Model A" }
			fake.modelRegistry = {
				...fake.modelRegistry,
				getAvailable: () => [{ provider: "provider-a", id: "model-a", name: "Model A" }],
			}
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: "/tmp/fake-agent-dir",
				sessionFactory: async () => asSession(fake),
			})
			await agent.newSession({ cwd: "/tmp", mcpServers: [] })

			await expect(
				agent.setSessionConfigOption({
					sessionId: "test-session-model-unknown",
					configId: "model",
					value: "provider-b/model-b",
				}),
			).rejects.toThrow(/model not found/)
		})

		it("returns updated configOptions when model changes", async () => {
			const fake = new FakeAgentSession("test-session-model-return")
			fake.model = { provider: "provider-a", id: "model-a", name: "Model A" }
			fake.modelRegistry = {
				...fake.modelRegistry,
				getAvailable: () => [
					{ provider: "provider-a", id: "model-a", name: "Model A" },
					{ provider: "provider-b", id: "model-b", name: "Model B" },
				],
			}
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: "/tmp/fake-agent-dir",
				sessionFactory: async () => asSession(fake),
			})
			await agent.newSession({ cwd: "/tmp", mcpServers: [] })

			const res = await agent.setSessionConfigOption({
				sessionId: "test-session-model-return",
				configId: "model",
				value: "provider-b/model-b",
			})

			const modelOption = res.configOptions?.find((o) => o.id === "model")
			expect(modelOption?.currentValue).toBe("provider-b/model-b")
		})

		it("rejects model change when a prompt is in progress", async () => {
			const fake = new FakeAgentSession("test-session-model-busy")
			fake.model = { provider: "provider-a", id: "model-a", name: "Model A" }
			fake.modelRegistry = {
				...fake.modelRegistry,
				getAvailable: () => [
					{ provider: "provider-a", id: "model-a", name: "Model A" },
					{ provider: "provider-b", id: "model-b", name: "Model B" },
				],
			}
			let releasePrompt!: () => void
			const promptReleased = new Promise<void>((resolve) => {
				releasePrompt = resolve
			})
			fake.promptImpl = async () => {
				fake.emit({ type: "agent_start" })
				await promptReleased
			}
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: "/tmp/fake-agent-dir",
				sessionFactory: async () => asSession(fake),
			})
			await agent.newSession({ cwd: "/tmp", mcpServers: [] })

			const promptP = agent.prompt({
				sessionId: "test-session-model-busy",
				prompt: [{ type: "text", text: "x" }],
			})
			await delay(10)

			await expect(
				agent.setSessionConfigOption({
					sessionId: "test-session-model-busy",
					configId: "model",
					value: "provider-b/model-b",
				}),
			).rejects.toThrow(/prompt is already in progress/)

			// Release the prompt so the test runner doesn't wait on it.
			releasePrompt()
			await promptP
		})
	})

	it("emits config_option_update when permission mode changes", async () => {
		const { conn, updates } = makeRecordingConn()
		const fake = new FakeAgentSession("test-session-notify")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})

		// Create a session (this subscribes to mode changes)
		const { sessionId } = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		})

		// Change the mode using setSessionConfigOption (this emits the notification)
		await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "plan",
		})

		// Check that config_option_update was emitted
		const configUpdates = updates.filter((u) => u.update.sessionUpdate === "config_option_update")
		expect(configUpdates).toHaveLength(1)
		expect(configUpdates[0].sessionId).toBe(sessionId)
		// Type assertion needed because SessionUpdate is a union type
		const configUpdate = configUpdates[0].update as {
			sessionUpdate: "config_option_update"
			configOptions: Array<{ id: string; currentValue: string }>
		}
		expect(configUpdate.configOptions[0].id).toBe("permissions-mode")
		expect(configUpdate.configOptions[0].currentValue).toBe("plan")
	})

	it("session-scoped mode is used by permissions extension for tool gating", async () => {
		const fake = new FakeAgentSession("test-session-enforcement")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})

		// Create a session
		const { sessionId } = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		})

		// Verify initial mode is default
		const initialRes = await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "default",
		})
		expect(initialRes.configOptions[0].currentValue).toBe("default")

		// Switch to plan mode via ACP
		await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "plan",
		})

		// Verify the mode was updated
		const controller = getSessionPermissionFlagController(sessionId)
		expect(controller).toBeDefined()
		expect(controller?.getMode()).toEqual({ mode: "plan", source: "runtime", initiatedBy: "user" })

		// Verify mode can be switched back
		await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "yolo",
		})
		expect(controller?.getMode()).toEqual({ mode: "yolo", source: "runtime", initiatedBy: "user" })

		// Cleanup
		await agent.unstable_closeSession({ sessionId })
		const afterClose = getSessionPermissionFlagController(sessionId)
		expect(afterClose).toBeUndefined()
	})

	it("mode changes via setSessionConfigOption are visible to permissions extension currentMode", async () => {
		const fake = new FakeAgentSession("test-session-permissions-integration")
		// Ensure clean env state - previous tests may have set this
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})

		// Create a session
		const { sessionId } = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		})

		// Verify the session controller is registered
		const controller = getSessionPermissionFlagController(sessionId)
		expect(controller).toBeDefined()
		expect(controller?.getMode()).toEqual({ mode: "default", source: "config", initiatedBy: "user" })

		// Change to plan mode via ACP
		await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "plan",
		})

		// Verify the controller reflects the new mode

		expect(controller?.getMode()).toEqual({ mode: "plan", source: "runtime", initiatedBy: "user" })

		await agent.unstable_closeSession({ sessionId })
	})

	it("delivers config_option_update to multiple concurrent sessions independently", async () => {
		const updates1: SessionNotification[] = []
		const updates2: SessionNotification[] = []

		// Create a connection that splits notifications by sessionId
		const conn = {
			sessionUpdate: async (msg: SessionNotification) => {
				if (msg.sessionId === "multi-session-1") {
					updates1.push(msg)
				} else if (msg.sessionId === "multi-session-2") {
					updates2.push(msg)
				}
			},
		} as unknown as AgentSideConnection

		let callCount = 0
		const fake1 = new FakeAgentSession("multi-session-1")
		const fake2 = new FakeAgentSession("multi-session-2")

		// One agent with a session factory that returns different sessions
		const agent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => {
				callCount++
				return asSession(callCount === 1 ? fake1 : fake2)
			},
		})

		const { sessionId: sid1 } = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		})
		const { sessionId: sid2 } = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		})

		// Verify sessions are under the same agent (same entries map)
		expect(sid1).toBe("multi-session-1")
		expect(sid2).toBe("multi-session-2")

		const filter = (u: SessionNotification) => u.update.sessionUpdate === "config_option_update"

		// Change mode via session 1 — only session 1 is notified
		await agent.setSessionConfigOption({
			sessionId: sid1,
			configId: "permissions-mode",
			value: "yolo",
		})

		// Session 1 should have exactly 1 notification (its own)
		expect(updates1.filter(filter)).toHaveLength(1)
		// Session 2 should have no notification yet
		expect(updates2.filter(filter)).toHaveLength(0)

		// Change mode via session 2 — only session 2 is notified
		await agent.setSessionConfigOption({
			sessionId: sid2,
			configId: "permissions-mode",
			value: "auto",
		})

		// Session 1 should still have only 1 notification
		expect(updates1.filter(filter)).toHaveLength(1)
		// Session 2 should now have exactly 1 notification
		expect(updates2.filter(filter)).toHaveLength(1)
	})
})

describe("ACP mode controller integration with permissions extension", () => {
	// Import permissions extension test utilities
	async function createPermissionsHarness(tools: string[], flags: Record<string, unknown> = {}) {
		const { default: permissionsExtension } = await import("../../extensions/permissions/index.js")
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>()
		const commands = new Map<
			string,
			{
				description: string
				handler: (args: string, ctx: unknown) => Promise<void> | void
			}
		>()
		let activeTools: string[] = []

		const pi = {
			on: (event: string, handler: (...args: unknown[]) => unknown) => {
				const list = handlers.get(event) ?? []
				list.push(handler)
				handlers.set(event, list)
			},
			registerCommand: (
				name: string,
				command: {
					description: string
					handler: (args: string, ctx: unknown) => Promise<void> | void
				},
			) => {
				commands.set(name, command)
			},
			getAllTools: () => tools,
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => {
				activeTools = names.filter((n) => tools.includes(n))
			},
			getFlag: (name: string) => flags[name],
			registerFlag: () => {},
			registerTool: () => {},
			sendMessage: () => {},
			appendEntry: () => {},
			events: createMiniEventBus().events,
			getEnvironment: () => ({
				environmentInfo: {
					permittedTools: new Set(tools),
				},
			}),
			setActiveToolIdsByServer: () => {},
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI

		permissionsExtension(pi)

		return {
			async fireSessionStart(ctx: unknown) {
				for (const handler of handlers.get("session_start") ?? []) {
					await handler({}, ctx)
				}
			},
			async fireToolCall(event: { toolName: string; input: unknown }, ctx: unknown) {
				const toolHandlers = handlers.get("tool_call") ?? []
				for (const handler of toolHandlers) {
					const result = await handler(event, ctx)
					if (result) return result
				}
				return undefined
			},
			commands,
		}
	}

	function createMockContext(sessionId: string, cwd: string): ExtensionContext {
		return {
			sessionManager: {
				getSessionId: vi.fn().mockReturnValue(sessionId),
				getEntries: () => [],
			} as unknown as SessionManager,
			cwd,
			mode: "rpc",
			hasUI: true,
			ui: {
				notify: vi.fn(),
				setStatus: vi.fn(),
				onTerminalInput: vi.fn(),
				theme: {
					fg: vi.fn(),
					bg: vi.fn(),
					getFgAnsi: vi.fn(),
				} as unknown as Theme,
			} as unknown as ExtensionUIContext,
			modelRegistry: {
				authStorage: {},
				getApiKeyAndHeaders: vi.fn().mockReturnValue({ ok: true, apiKey: "test" }),
				getAvailable: vi.fn().mockReturnValue([
					{
						id: "kimi",
						name: "kimi",
					},
				]),
				find: vi.fn().mockReturnValue({ id: "kimi", name: "kimi" }),
			} as unknown as ModelRegistry,
		} as unknown as ExtensionContext
	}

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("plan mode via ACP blocks write operations through permissions extension", async () => {
		// Clean env state
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const sessionId = "test-plan-mode-session"
		const cwd = "/tmp"

		// Set up permissions extension with write tool
		const harness = await createPermissionsHarness(["write", "read"])

		// Create an ACP session (registers the controller)
		const fake = new FakeAgentSession(sessionId)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})

		await agent.newSession({ cwd, mcpServers: [] })

		// Fire session_start so the permissions extension subscribes to the controller
		const mockCtx = createMockContext(sessionId, cwd)
		await harness.fireSessionStart(mockCtx)

		// Verify controller is registered
		const controller = getSessionPermissionFlagController(sessionId)
		expect(controller).toBeDefined()

		// Switch to plan mode via ACP
		await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "plan",
		})

		// Verify controller mode is plan
		expect(controller?.getMode()).toEqual({ mode: "plan", source: "runtime", initiatedBy: "user" })
		const writeToolEvent = {
			toolName: "write",
			input: { path: "/tmp/test.txt", content: "hello" },
		}

		const result = (await harness.fireToolCall(writeToolEvent, mockCtx)) as
			| { block: boolean; reason: string }
			| undefined

		// Should be blocked in plan mode
		expect(result).toBeDefined()
		expect(result?.block).toBe(true)
		expect(result?.reason).toContain("Plan")

		// Cleanup
		await agent.unstable_closeSession({ sessionId })
	})

	it("yolo mode via ACP allows write operations through permissions extension", async () => {
		// Clean env state
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const sessionId = "test-yolo-mode-session"
		const cwd = "/tmp"

		// Set up permissions extension
		const harness = await createPermissionsHarness(["write", "read", "bash"])

		// Create an ACP session
		const fake = new FakeAgentSession(sessionId)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})

		await agent.newSession({ cwd, mcpServers: [] })

		// Fire session_start so the permissions extension subscribes to the controller
		const mockCtx = createMockContext(sessionId, cwd)
		await harness.fireSessionStart(mockCtx)

		// Switch to yolo mode via ACP
		await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "yolo",
		})

		// Verify controller mode is yolo
		const controller = getSessionPermissionFlagController(sessionId)
		expect(controller?.getMode()).toEqual({ mode: "yolo", source: "runtime", initiatedBy: "user" })
		const writeToolEvent = {
			toolName: "write",
			input: { path: "/tmp/test.txt", content: "hello" },
		}

		const result = await harness.fireToolCall(writeToolEvent, mockCtx)

		// Should NOT be blocked in yolo mode
		expect(result).toBeUndefined()

		// Cleanup
		await agent.unstable_closeSession({ sessionId })
	})

	it("setSessionConfigOption emits exactly one config_option_update when permissions extension is active", async () => {
		// Regression test for the double-notification bug:
		// setSessionConfigOption -> controller.setMode fires the ACP notification subscriber.
		// The permissions extension's session_start subscriber also fires changeMode ->
		// setRuntimePermissionMode, which must NOT re-enter controller.setMode (which would
		// fire a second notification). The insideControllerCallback guard prevents this.
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const sessionId = "test-no-double-notify"
		const cwd = "/tmp"

		const harness = await createPermissionsHarness(["write", "read"])

		const { conn, updates } = makeRecordingConn()
		const fake = new FakeAgentSession(sessionId)
		const agent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})

		await agent.newSession({ cwd, mcpServers: [] })

		// Fire session_start so the permissions extension subscribes to the controller.
		const mockCtx = createMockContext(sessionId, cwd)
		await harness.fireSessionStart(mockCtx)

		// Drain any notifications emitted during session setup.
		updates.length = 0

		// Change mode — this is the operation that previously emitted two notifications.
		await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "plan",
		})

		const configUpdates = updates.filter((u) => u.update.sessionUpdate === "config_option_update")
		expect(configUpdates).toHaveLength(1)
		// biome-ignore lint/suspicious/noExplicitAny: union type requires assertion
		const update = configUpdates[0].update as any
		expect(update.configOptions[0].currentValue).toBe("plan")

		await agent.unstable_closeSession({ sessionId })
	})

	it("leaving plan mode via ACP restores write/edit tools and emits exactly one config update", async () => {
		// Changing permissions-mode through ACP must run the full changeMode transition,
		// including restoring tool visibility and aborting stale permission prompts.
		// The skipNotify flag should prevent duplicate ACP config updates.
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const sessionId = "test-leave-plan-mode"
		const cwd = "/tmp"

		// Set up harness with write and edit tools that would be hidden in plan mode
		const harness = await createPermissionsHarness(["write", "edit", "read", "bash"])

		const { conn, updates } = makeRecordingConn()
		const fake = new FakeAgentSession(sessionId)
		const agent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})

		await agent.newSession({ cwd, mcpServers: [] })

		// Fire session_start so the permissions extension subscribes to the controller
		const mockCtx = createMockContext(sessionId, cwd)
		await harness.fireSessionStart(mockCtx)

		// Clear any notifications from setup
		updates.length = 0

		// Start in plan mode via ACP
		await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "plan",
		})

		// Verify we're in plan mode - write/edit should be blocked by permissions extension
		const writeBlockedResult = (await harness.fireToolCall(
			{ toolName: "write", input: { path: "/tmp/test.txt", content: "hello" } },
			mockCtx,
		)) as { block: boolean; reason: string }
		expect(writeBlockedResult?.block).toBe(true)
		expect(writeBlockedResult?.reason).toContain("Plan mode")

		// Clear notifications from entering plan mode
		updates.length = 0

		// Test leaving plan mode to yolo
		await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "yolo",
		})

		// Verify exactly one config_option_update was emitted
		const yoloConfigUpdates = updates.filter((u) => u.update.sessionUpdate === "config_option_update")
		expect(yoloConfigUpdates).toHaveLength(1)
		// biome-ignore lint/suspicious/noExplicitAny: union type requires assertion
		const yoloUpdate = yoloConfigUpdates[0].update as any
		expect(yoloUpdate.configOptions[0].currentValue).toBe("yolo")

		// Verify write operations are now allowed (permissions extension allows them in yolo)
		const writeAllowedResult = await harness.fireToolCall(
			{ toolName: "write", input: { path: "/tmp/test.txt", content: "hello" } },
			mockCtx,
		)
		expect(writeAllowedResult).toBeUndefined() // Not blocked

		// Reset and test leaving plan mode to default
		updates.length = 0

		// Go back to plan mode
		await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "plan",
		})
		updates.length = 0 // Clear notifications

		// Verify tools are blocked again in plan mode
		const writeBlockedAgain = (await harness.fireToolCall(
			{ toolName: "write", input: { path: "/tmp/test.txt", content: "hello" } },
			mockCtx,
		)) as { block: boolean; reason: string }
		expect(writeBlockedAgain?.block).toBe(true)

		// Leave plan mode to default
		await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "default",
		})

		// Verify exactly one config_option_update was emitted
		const defaultConfigUpdates = updates.filter((u) => u.update.sessionUpdate === "config_option_update")
		expect(defaultConfigUpdates).toHaveLength(1)
		// biome-ignore lint/suspicious/noExplicitAny: union type requires assertion
		const defaultUpdate = defaultConfigUpdates[0].update as any
		expect(defaultUpdate.configOptions[0].currentValue).toBe("default")

		// Verify write operations are now gated behind explicit user approval
		const writeDefaultResult = (await harness.fireToolCall(
			{ toolName: "write", input: { path: "/tmp/test.txt", content: "hello" } },
			mockCtx,
		)) as { block: boolean; reason: string }
		expect(writeDefaultResult.block).toBe(true)
		expect(writeDefaultResult.reason).toContain("Declined by user")

		await agent.unstable_closeSession({ sessionId })
	})
})

describe("session mode controller lifecycle", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
		for (const key of Object.keys(process.env)) {
			if (key.startsWith(`${PERMISSIONS_ENV_KEY}_`)) {
				Reflect.deleteProperty(process.env, key)
			}
		}
		unregisterSessionPermissionFlagController("env-baseline-1")
		unregisterSessionPermissionFlagController("env-default-1")
		unregisterSessionPermissionFlagController("config-default-1")
		unregisterSessionPermissionFlagController("env-beats-config-1")
		unregisterSessionPermissionFlagController("no-leak-1")
		unregisterSessionPermissionFlagController("no-leak-2")
	})

	it("unregisters mode controller on closeSession", async () => {
		const fake = new FakeAgentSession("close-mode-ctrl")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})

		const { sessionId } = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		})
		expect(getSessionPermissionFlagController(sessionId)).toBeDefined()

		await agent.unstable_closeSession({ sessionId })
		expect(getSessionPermissionFlagController(sessionId)).toBeUndefined()
	})

	it("unregisters mode controllers on shutdown", async () => {
		const fake1 = new FakeAgentSession("shutdown-mode-1")
		const fake2 = new FakeAgentSession("shutdown-mode-2")
		let callCount = 0
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(++callCount === 1 ? fake1 : fake2),
		})

		const r1 = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		const r2 = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		expect(getSessionPermissionFlagController(r1.sessionId)).toBeDefined()
		expect(getSessionPermissionFlagController(r2.sessionId)).toBeDefined()

		await agent.shutdown()
		expect(getSessionPermissionFlagController(r1.sessionId)).toBeUndefined()
		expect(getSessionPermissionFlagController(r2.sessionId)).toBeUndefined()
	})

	it("seeds initial mode from env baseline, not from live env mutations", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "auto")
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(new FakeAgentSession("env-baseline-1")),
		})

		// Mutate env after construction (simulates another session writing to env)
		process.env[PERMISSIONS_ENV_KEY] = "yolo"

		const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		// Should use the snapshotted baseline (auto), not the live env (yolo)
		expect(res.configOptions?.[0].currentValue).toBe("auto")
	})

	it("defaults to 'default' mode when KIMCHI_PERMISSIONS env is unset", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(new FakeAgentSession("env-unset")),
		})

		const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		expect(res.configOptions?.[0].currentValue).toBe("default")
	})

	it("uses defaultMode from permissions config file when env is not set", async () => {
		// Create a temp directory with a .kimchi/permissions.json
		const tmpDir = mkdtempSync(join(tmpdir(), "acp-mode-config-test-"))
		const kimchiDir = join(tmpDir, ".kimchi")
		mkdirSync(kimchiDir, { recursive: true })
		writeFileSync(join(kimchiDir, "permissions.json"), JSON.stringify({ defaultMode: "plan" }))

		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		try {
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: "/tmp/fake-agent-dir",
				sessionFactory: async (params) => asSession(new FakeAgentSession("config-mode", params.cwd)),
			})

			const res = await agent.newSession({ cwd: tmpDir, mcpServers: [] })
			expect(res.configOptions?.[0].currentValue).toBe("plan")
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	it("env KIMCHI_PERMISSIONS takes precedence over config defaultMode", async () => {
		// Create a temp directory with a .kimchi/permissions.json
		const tmpDir = mkdtempSync(join(tmpdir(), "acp-mode-env-precedence-test-"))
		const kimchiDir = join(tmpDir, ".kimchi")
		mkdirSync(kimchiDir, { recursive: true })
		writeFileSync(join(kimchiDir, "permissions.json"), JSON.stringify({ defaultMode: "plan" }))

		// Set env to a different mode
		vi.stubEnv(PERMISSIONS_ENV_KEY, "auto")

		try {
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: "/tmp/fake-agent-dir",
				sessionFactory: async (params) => asSession(new FakeAgentSession("env-precedence", params.cwd)),
			})

			const res = await agent.newSession({ cwd: tmpDir, mcpServers: [] })
			// Env should take precedence over config
			expect(res.configOptions?.[0].currentValue).toBe("auto")
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	it("per-session mode changes do not leak across sessions", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)
		const fake1 = new FakeAgentSession("isolate-1")
		const fake2 = new FakeAgentSession("isolate-2")
		let callCount = 0
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(++callCount === 1 ? fake1 : fake2),
		})

		const r1 = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		const r2 = await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		// Both sessions start at "default"
		expect(getSessionPermissionFlagController(r1.sessionId)?.getMode()).toEqual({
			mode: "default",
			source: "config",
			initiatedBy: "user",
		})
		expect(getSessionPermissionFlagController(r2.sessionId)?.getMode()).toEqual({
			mode: "default",
			source: "config",
			initiatedBy: "user",
		})

		// Change session 1 to yolo
		await agent.setSessionConfigOption({
			sessionId: r1.sessionId,
			configId: "permissions-mode",
			value: "yolo",
		})

		// Session 1 is yolo, session 2 is still default
		expect(getSessionPermissionFlagController(r1.sessionId)?.getMode()).toEqual({
			mode: "yolo",
			source: "runtime",
			initiatedBy: "user",
		})
		expect(getSessionPermissionFlagController(r2.sessionId)?.getMode()).toEqual({
			mode: "default",
			source: "config",
			initiatedBy: "user",
		})
	})

	it("closeSession deletes the KIMCHI_PERMISSIONS_<sessionId> env key", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const fake = new FakeAgentSession("close-env-key")
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})

		const { sessionId } = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		})

		// Set a mode so the namespaced env key is definitely written.
		await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "yolo",
		})
		const envKey = `${PERMISSIONS_ENV_KEY}_${sessionId}`
		expect(process.env[envKey]).toBe("yolo")

		await agent.unstable_closeSession({ sessionId })

		expect(process.env[envKey]).toBeUndefined()
	})

	it("shutdown deletes KIMCHI_PERMISSIONS_<sessionId> env keys for all sessions", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const fake1 = new FakeAgentSession("shutdown-env-1")
		const fake2 = new FakeAgentSession("shutdown-env-2")
		let callCount = 0
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(++callCount === 1 ? fake1 : fake2),
		})

		const r1 = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		const r2 = await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		// Write a namespaced env key for each session.
		await agent.setSessionConfigOption({
			sessionId: r1.sessionId,
			configId: "permissions-mode",
			value: "plan",
		})
		await agent.setSessionConfigOption({
			sessionId: r2.sessionId,
			configId: "permissions-mode",
			value: "auto",
		})

		const key1 = `${PERMISSIONS_ENV_KEY}_${r1.sessionId}`
		const key2 = `${PERMISSIONS_ENV_KEY}_${r2.sessionId}`
		expect(process.env[key1]).toBe("plan")
		expect(process.env[key2]).toBe("auto")

		await agent.shutdown()

		expect(process.env[key1]).toBeUndefined()
		expect(process.env[key2]).toBeUndefined()
	})
})

describe("ACP newSession CLI permission mode flags", () => {
	it("--yolo flag sets initial permission mode to yolo", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)
		populateCliArgs(["--yolo"])

		const fake = new FakeAgentSession("cli-yolo-1")
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})

		const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		expect(res.configOptions?.[0].currentValue).toBe("yolo")

		const controller = getSessionPermissionFlagController(res.sessionId)
		expect(controller?.getMode()).toEqual({ mode: "yolo", source: "flag", initiatedBy: "user" })
	})

	it("CLI flag takes precedence over config defaultMode", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "acp-cli-flag-precedence-"))
		const kimchiDir = join(tmpDir, ".kimchi")
		mkdirSync(kimchiDir, { recursive: true })
		writeFileSync(join(kimchiDir, "permissions.json"), JSON.stringify({ defaultMode: "plan" }))

		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)
		populateCliArgs(["--yolo"])

		try {
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: "/tmp/fake-agent-dir",
				sessionFactory: async (params) => asSession(new FakeAgentSession("cli-precedence-1", params.cwd)),
			})

			const res = await agent.newSession({ cwd: tmpDir, mcpServers: [] })
			// --yolo flag should win over config defaultMode "plan"
			expect(res.configOptions?.[0].currentValue).toBe("yolo")
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})
})

// Helper for the listSessions tests: builds a pi SessionInfo with sensible
// defaults so each test only spells out the fields it cares about.
function makePiSession(overrides: Partial<PiSessionInfo> = {}): PiSessionInfo {
	return {
		path: "/tmp/sessions/x.jsonl",
		id: "id-x",
		cwd: "/tmp/proj",
		name: undefined,
		parentSessionPath: undefined,
		created: new Date("2026-01-01T00:00:00Z"),
		modified: new Date("2026-01-01T00:00:00Z"),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
		...overrides,
	}
}

// Direct coverage for the pi → ACP SessionInfo mapping. Title fallback and
// updatedAt formatting are both load-bearing for Zed's thread-picker UI.
describe("toAcpSessionInfo", () => {
	it("uses the user-defined name when present", () => {
		const out = toAcpSessionInfo(
			makePiSession({
				id: "s1",
				cwd: "/p",
				name: "named",
				firstMessage: "ignored",
			}),
		)
		expect(out).toEqual({
			sessionId: "s1",
			cwd: "/p",
			title: "named",
			updatedAt: "2026-01-01T00:00:00.000Z",
		})
	})

	it("falls back to truncated firstMessage when name is absent", () => {
		const long = "q".repeat(120)
		const out = toAcpSessionInfo(makePiSession({ firstMessage: long }))
		expect(out.title).toBe(`${"q".repeat(80)}…`)
	})

	it("returns null title when both name and firstMessage are empty", () => {
		const out = toAcpSessionInfo(makePiSession({ name: undefined, firstMessage: "" }))
		expect(out.title).toBeNull()
	})

	it("falls back to firstMessage when name is the empty string (not just undefined)", () => {
		// Pi types `name?: string`, but a hand-edited / migrated session info
		// entry can land with name === "". A previous version used `??` which
		// only short-circuits on null/undefined, so the fallback was skipped
		// and the title became null even though firstMessage was populated.
		const out = toAcpSessionInfo(makePiSession({ name: "", firstMessage: "hello world" }))
		expect(out.title).toBe("hello world")
	})

	it("formats updatedAt as ISO 8601 from the modified Date", () => {
		const out = toAcpSessionInfo(makePiSession({ modified: new Date("2026-05-09T12:34:56.789Z") }))
		expect(out.updatedAt).toBe("2026-05-09T12:34:56.789Z")
	})
})

describe("KimchiAcpAgent listSessions", () => {
	function makeAgent(lister: AcpSessionLister): KimchiAcpAgent {
		return new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(new FakeAgentSession("unused")),
			sessionLister: lister,
		})
	}

	it("advertises sessionCapabilities.list in initialize", async () => {
		const agent = makeAgent(async () => [])
		const init = await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {} as never,
		} as never)
		expect(init.agentCapabilities?.sessionCapabilities?.list).toEqual({})
	})

	it("dispatches to SessionManager.list when cwd is provided", async () => {
		let received: { cwd?: string | null } = {}
		const agent = makeAgent(async (params) => {
			received = { cwd: params.cwd }
			return []
		})
		await agent.listSessions({ cwd: "/repo/foo", mcpServers: [] } as never)
		expect(received.cwd).toBe("/repo/foo")
	})

	it("falls back to listAll when cwd is omitted", async () => {
		let cwdSeen: string | null | undefined = "sentinel"
		const agent = makeAgent(async (params) => {
			cwdSeen = params.cwd
			return []
		})
		await agent.listSessions({} as never)
		// Lister receives the original (undefined) cwd; the default lister maps
		// that to listAll(). Tests of the default lister itself live in pi.
		expect(cwdSeen).toBeUndefined()
	})

	it("forwards additionalDirectories to the session lister", async () => {
		let received: ListSessionsRequest | undefined
		const agent = makeAgent(async (params) => {
			received = params
			return []
		})
		await agent.listSessions({
			cwd: "/repo/foo",
			additionalDirectories: ["/repo/bar", "/repo/baz"],
		} as never)
		expect(received?.additionalDirectories).toEqual(["/repo/bar", "/repo/baz"])
	})

	it("dedupes sessions returned across multiple roots by id", async () => {
		// Custom lister stand-in for the multi-root default lister: returns the
		// same id from two roots; handler must surface it once.
		const dup = makePiSession({
			id: "shared",
			modified: new Date("2026-04-01T00:00:00Z"),
			name: "shared",
		})
		const uniq = makePiSession({
			id: "uniq",
			modified: new Date("2026-03-01T00:00:00Z"),
			name: "uniq",
		})
		const agent = makeAgent(async () => [dup, uniq, dup])
		const res = await agent.listSessions({ cwd: "/p" } as never)
		expect(res.sessions.map((s) => s.sessionId)).toEqual(["shared", "uniq"])
	})

	it("returns empty array for a directory with no sessions", async () => {
		const agent = makeAgent(async () => [])
		const res = await agent.listSessions({ cwd: "/empty" } as never)
		expect(res.sessions).toEqual([])
	})

	it("returns nextCursor: null to signal end-of-pagination", async () => {
		const agent = makeAgent(async () => [makePiSession({ id: "s" })])
		const res = await agent.listSessions({ cwd: "/p" } as never)
		expect(res.nextCursor).toBeNull()
	})

	it("sorts sessions newest-first by updatedAt", async () => {
		const piSessions: PiSessionInfo[] = [
			makePiSession({
				id: "old",
				modified: new Date("2026-01-01T00:00:00Z"),
				name: "old",
			}),
			makePiSession({
				id: "new",
				modified: new Date("2026-05-09T00:00:00Z"),
				name: "new",
			}),
			makePiSession({
				id: "mid",
				modified: new Date("2026-03-01T00:00:00Z"),
				name: "mid",
			}),
		]
		const agent = makeAgent(async () => piSessions)
		const res = await agent.listSessions({ cwd: "/p" } as never)
		expect(res.sessions.map((s) => s.sessionId)).toEqual(["new", "mid", "old"])
	})

	it("uses truncated firstMessage as title when name is absent", async () => {
		const long = "z".repeat(120)
		const agent = makeAgent(async () => [makePiSession({ id: "s", firstMessage: long, name: undefined })])
		const res = await agent.listSessions({ cwd: "/p" } as never)
		expect(res.sessions[0].title).toBe(`${"z".repeat(80)}…`)
	})

	it("excludes subagent sessions that have a parentSessionPath", async () => {
		const userSession = makePiSession({
			id: "user-session",
			name: "User session",
			parentSessionPath: undefined,
		})
		const subagentSession = makePiSession({
			id: "subagent-session",
			name: "Subagent session",
			parentSessionPath: "/tmp/sessions/parent.jsonl",
		})
		const agent = makeAgent(async () => [userSession, subagentSession])
		const res = await agent.listSessions({ cwd: "/p" } as never)
		expect(res.sessions.map((s) => s.sessionId)).toEqual(["user-session"])
	})
})

// Helpers for replay tests: build the SessionMessageEntry shape that
// SessionManager.getBranch() returns. `userText` / `assistantText` produce the
// minimal valid envelope — id/parentId/timestamp are not consulted by the
// replay walker, so any non-empty placeholder is fine.
function userTextEntry(text: string, id = "u1", parentId: string | null = null): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-05-09T00:00:00Z",
		message: { role: "user", content: text, timestamp: 0 },
	}
}
function assistantTextEntry(text: string, id = "a1", parentId: string | null = null): unknown {
	return assistantBlocksEntry([{ type: "text", text }], id, parentId)
}

// Variant that builds an assistant entry from arbitrary content blocks (text,
// thinking, toolCall). Used by replay tests to drop in mixed-block fixtures
// without re-spelling the message envelope each time.
function assistantBlocksEntry(content: unknown[], id = "a1", parentId: string | null = null): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-05-09T00:00:01Z",
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
	}
}

function toolResultEntry(
	toolCallId: string,
	toolName: string,
	text: string,
	isError = false,
	id = `tr-${toolCallId}`,
	parentId: string | null = null,
): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-05-09T00:00:02Z",
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError,
			timestamp: 0,
		},
	}
}

function testEncodeCwdDir(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

describe("KimchiAcpAgent loadSession", () => {
	function makeAgent(loader: AcpSessionLoader, opts?: { conn?: AgentSideConnection }): KimchiAcpAgent {
		return new KimchiAcpAgent(opts?.conn ?? makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(new FakeAgentSession("unused")),
			sessionLoader: loader,
		})
	}

	it("advertises loadSession capability in initialize", async () => {
		const agent = makeAgent(async () => asSession(new FakeAgentSession("unused")))
		const init = await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {} as never,
		} as never)
		expect(init.agentCapabilities?.loadSession).toBe(true)
		expect(init.agentCapabilities?.sessionCapabilities?.close).toEqual({})
	})

	it("rejects loadSession when mcpServers is non-empty (does not invoke loader)", async () => {
		const loaderCalls = { count: 0 }
		const loader: AcpSessionLoader = async () => {
			loaderCalls.count++
			return asSession(new FakeAgentSession("unused"))
		}
		const agent = makeAgent(loader)
		await expect(
			agent.loadSession({
				sessionId: "s1",
				cwd: "/tmp",
				// biome-ignore lint/suspicious/noExplicitAny: only the shape we care about
				mcpServers: [{ name: "x", command: "x", args: [] } as any],
			}),
		).rejects.toMatchObject({ code: -32602 })
		expect(loaderCalls.count).toBe(0)
	})

	it("replays and returns an already loaded session without reopening it", async () => {
		const loaderCalls = { count: 0 }
		const live = new FakeAgentSession("live-1")
		live.branch = [userTextEntry("already here", "u1", null)]
		const factory: AcpSessionFactory = async () => asSession(live)
		const loader: AcpSessionLoader = async () => {
			loaderCalls.count++
			return asSession(new FakeAgentSession("unused"))
		}
		const { conn, updates } = makeRecordingConn()
		const agent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
			sessionLoader: loader,
		})
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const res = await agent.loadSession({
			sessionId: "live-1",
			cwd: "/tmp",
			mcpServers: [],
		})

		expect(res.models).toMatchObject({
			currentModelId: "test/test-model",
		})
		expect(loaderCalls.count).toBe(0)

		const replayUpdates = replayOnly(updates)
		// loadSession replay sends user_message_chunk
		expect(replayUpdates).toHaveLength(1)
		expect(replayUpdates[0].update).toMatchObject({
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "already here" },
		})
	})

	it("returns configOptions in loadSession response", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "kimchi-acp-load-config-"))
		try {
			const fake = new FakeAgentSession("test-load-session-config")
			const sessionFactory: AcpSessionFactory = async () => asSession(fake)
			const lister: AcpSessionLister = async () => [
				makePiSession({
					id: "test-load-session-config",
					cwd: tmpDir,
					path: join(tmpDir, "test-load-session-config.jsonl"),
				}),
			]
			const loader: AcpSessionLoader = async () => {
				return asSession(fake)
			}
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tmpDir,
				sessionFactory,
				sessionLister: lister,
				sessionLoader: loader,
			})

			// Create the session first
			await agent.newSession({ cwd: tmpDir, mcpServers: [] })

			// Close it
			await agent.unstable_closeSession({
				sessionId: "test-load-session-config",
			})

			// Load it back
			const res = await agent.loadSession({
				sessionId: "test-load-session-config",
				cwd: tmpDir,
				mcpServers: [],
			})

			expect(res.configOptions).toBeDefined()
			expect(res.configOptions).toHaveLength(2)
			expect(res.configOptions?.[0].id).toBe("permissions-mode")
			expect(res.configOptions?.[1].id).toBe("model")
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	it("coalesces concurrent loadSession requests for the same sessionId", async () => {
		const fake = new FakeAgentSession("coalesce-1")
		let loaderCalls = 0
		let markLoaderStarted!: () => void
		let releaseLoader!: () => void
		const loaderStarted = new Promise<void>((resolve) => {
			markLoaderStarted = resolve
		})
		const release = new Promise<void>((resolve) => {
			releaseLoader = resolve
		})
		const loader: AcpSessionLoader = async () => {
			loaderCalls++
			markLoaderStarted()
			await release
			return asSession(fake)
		}
		const agent = makeAgent(loader)
		const first = agent.loadSession({
			sessionId: "coalesce-1",
			cwd: "/tmp",
			mcpServers: [],
		})
		await loaderStarted
		const second = agent.loadSession({
			sessionId: "coalesce-1",
			cwd: "/tmp",
			mcpServers: [],
		})
		releaseLoader()

		await expect(Promise.all([first, second])).resolves.toHaveLength(2)
		expect(loaderCalls).toBe(1)
	})

	it("propagates loader errors (e.g. missing file → invalidParams)", async () => {
		const agent = makeAgent(async () => {
			throw Object.assign(new Error("session not found"), { code: -32602 })
		})
		await expect(agent.loadSession({ sessionId: "missing", cwd: "/tmp", mcpServers: [] })).rejects.toThrow(
			/session not found/,
		)
	})

	it("rejects default-loaded sessions whose header cwd disagrees before opening", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "kimchi-acp-load-"))
		try {
			const sessionId = "cwd-mismatch"
			const requestedCwd = "/tmp/requested"
			const sessionDir = join(agentDir, "sessions", testEncodeCwdDir(requestedCwd))
			mkdirSync(sessionDir, { recursive: true })
			writeFileSync(
				join(sessionDir, `2026-05-09T00-00-00.000Z_${sessionId}.jsonl`),
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: sessionId,
					timestamp: "2026-05-09T00:00:00Z",
					cwd: "/tmp/other",
				})}\n`,
			)
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir,
				sessionFactory: async () => asSession(new FakeAgentSession("unused")),
			})

			await expect(agent.loadSession({ sessionId, cwd: requestedCwd, mcpServers: [] })).rejects.toThrow(
				/session cwd \/tmp\/other does not match requested cwd \/tmp\/requested/,
			)
		} finally {
			rmSync(agentDir, { recursive: true, force: true })
		}
	})

	it("disposes the session if subscribe throws during loadSession", async () => {
		const leaky = new FakeAgentSession("leak-1")
		leaky.subscribe = () => {
			throw new Error("subscribe boom")
		}
		const agent = makeAgent(async () => asSession(leaky))
		await expect(agent.loadSession({ sessionId: "leak-1", cwd: "/tmp", mcpServers: [] })).rejects.toThrow(
			/subscribe boom/,
		)
		expect(leaky.disposed).toBe(true)
	})

	it("unwinds registration and disposes the session if replay throws", async () => {
		// Pin the atomic-ownership invariant: a throw during replay must remove
		// the session from the registry AND dispose it, otherwise the id stays
		// "live" while loadSession rejects — blocking re-load with invalidRequest.
		const fake = new FakeAgentSession("replay-boom")
		fake.sessionManager = {
			...fake.sessionManager,
			getBranch: () => {
				throw new Error("branch read failed")
			},
		}
		const agent = makeAgent(async () => asSession(fake))
		await expect(
			agent.loadSession({
				sessionId: "replay-boom",
				cwd: "/tmp",
				mcpServers: [],
			}),
		).rejects.toThrow(/branch read failed/)
		expect(fake.disposed).toBe(true)
		// Re-load must not see the failed session as already-live.
		fake.sessionManager = { ...fake.sessionManager, getBranch: () => [] }
		fake.disposed = false
		await expect(
			agent.loadSession({
				sessionId: "replay-boom",
				cwd: "/tmp",
				mcpServers: [],
			}),
		).resolves.toBeDefined()
	})

	it("replays user/assistant text turns as session/update notifications before the response resolves", async () => {
		const fake = new FakeAgentSession("loaded-1")
		fake.model = { provider: "test", id: "test-model", name: "Test Model" }
		fake.modelRegistry = {
			...fake.modelRegistry,
			getAvailable: () => [{ provider: "test", id: "test-model", name: "Test Model" }],
		}
		fake.branch = [
			userTextEntry("hello", "u1", null),
			assistantTextEntry("hi there", "a1", "u1"),
			userTextEntry("how are you?", "u2", "a1"),
			assistantTextEntry("doing well", "a2", "u2"),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })

		// Capture the order: replay notifications must land BEFORE the response
		// resolves so Zed sees a coherent transcript on the load promise.
		const updatesAtResolve: (typeof updates)[number][] = []
		const original = (
			conn as unknown as {
				sessionUpdate: (p: SessionNotification) => Promise<void>
			}
		).sessionUpdate
		;(
			conn as unknown as {
				sessionUpdate: (p: SessionNotification) => Promise<void>
			}
		).sessionUpdate = async (p: SessionNotification) => {
			await original(p)
		}

		const res = await agent.loadSession({
			sessionId: "loaded-1",
			cwd: "/tmp",
			mcpServers: [],
		})
		// Snapshot updates seen at this point (ie. before any further awaits).
		// Drop the incidental available_commands_update so we can assert on
		// transcript shape without coupling to the command palette.
		updatesAtResolve.push(...replayOnly(updates))

		expect(updatesAtResolve).toHaveLength(4)
		expect(updatesAtResolve[0].update).toMatchObject({
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "hello" },
		})
		expect(updatesAtResolve[1].update).toMatchObject({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "hi there" },
		})
		expect(updatesAtResolve[2].update).toMatchObject({
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "how are you?" },
		})
		expect(updatesAtResolve[3].update).toMatchObject({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "doing well" },
		})
		expect(res.models).toMatchObject({
			currentModelId: "test/test-model",
			availableModels: [
				{
					modelId: "multi-model",
					name: expect.stringMatching(/^Multi-model \(/),
				},
				{ modelId: "test/test-model", name: "Test Model" },
			],
		})
	})

	// Replay walker: text + thinking + tool calls all surface as their own
	// session/update notifications; non-message entries (compaction,
	// branch_summary, model_change, custom) emit nothing. The block of tests
	// below exercises one fixture per kind plus a combined fixture.

	it("rejects a load whose session-header id disagrees with the requested sessionId", async () => {
		// Defensive: pi reads sessionId from the JSONL header, not the file
		// name. A corrupt / hand-edited session whose header drifted from the
		// filename would otherwise land in `sessions` under a different key
		// than the client knows, and subsequent prompts would 404 even though
		// the file is held open.
		const fake = new FakeAgentSession("header-id")
		const loader: AcpSessionLoader = async () => asSession(fake)
		const agent = makeAgent(loader)
		await expect(
			agent.loadSession({
				sessionId: "requested-id",
				cwd: "/tmp",
				mcpServers: [],
			}),
		).rejects.toMatchObject({
			code: -32602,
		})
		expect(fake.disposed).toBe(true)
	})

	it("coalesces contiguous text blocks within an assistant message into one chunk", async () => {
		// Replay contract: emit the full message as a single chunk. Adjacent
		// text blocks (rare but legal) must merge into one agent_message_chunk;
		// structural blocks (thinking / toolCall) flush the buffer so ordering
		// stays faithful.
		const fake = new FakeAgentSession("loaded-coalesce")
		fake.branch = [
			userTextEntry("go", "u1", null),
			assistantBlocksEntry(
				[
					{ type: "text", text: "first " },
					{ type: "text", text: "second" },
					{ type: "thinking", thinking: "pondering" },
					{ type: "text", text: "third" },
				],
				"a1",
				"u1",
			),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({
			sessionId: "loaded-coalesce",
			cwd: "/tmp",
			mcpServers: [],
		})
		const replay = replayOnly(updates)
		expect(replay.map((u) => u.update.sessionUpdate)).toEqual([
			"user_message_chunk",
			"agent_message_chunk",
			"agent_thought_chunk",
			"agent_message_chunk",
		])
		expect((replay[1].update as { content: { text: string } }).content.text).toBe("first second")
		expect((replay[3].update as { content: { text: string } }).content.text).toBe("third")
	})

	it("routes ANSI-dimmed replay text to thought chunks and strips remaining ANSI", async () => {
		// hide-thinking-aware models (DeepSeek, QwQ) persist text with ANSI dim escapes around inner <think> content. The
		// live TUI renders them as reasoning; ACP's text content type is
		// plaintext, so replay must preserve that semantic split explicitly.
		const dimmed = "before \x1b[2minner\x1b[22m after"
		const fake = new FakeAgentSession("loaded-ansi")
		fake.branch = [
			userTextEntry("go", "u1", null),
			assistantBlocksEntry(
				[
					{ type: "text", text: dimmed },
					{ type: "thinking", thinking: "raw \x1b[2mthought\x1b[22m" },
				],
				"a1",
				"u1",
			),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({
			sessionId: "loaded-ansi",
			cwd: "/tmp",
			mcpServers: [],
		})
		const messageTexts = updates
			.filter((u) => u.update.sessionUpdate === "agent_message_chunk")
			.map((u) => (u.update as { content: { text: string } }).content.text)
		const thoughtTexts = updates
			.filter((u) => u.update.sessionUpdate === "agent_thought_chunk")
			.map((u) => (u.update as { content: { text: string } }).content.text)
		expect(messageTexts).toEqual(["before ", " after"])
		expect(thoughtTexts).toEqual(["inner", "raw thought"])
	})

	it("treats a concurrent session/cancel during replay as a no-op (no turn active)", async () => {
		const fake = new FakeAgentSession("loaded-cancel")
		fake.branch = [userTextEntry("hi", "u1", null)]
		const agent = makeAgent(async () => asSession(fake))
		await agent.loadSession({
			sessionId: "loaded-cancel",
			cwd: "/tmp",
			mcpServers: [],
		})
		// No turn was created during loadSession, so cancel must not throw and
		// must not invoke abort with side effects beyond the no-op session.abort.
		await expect(agent.cancel({ sessionId: "loaded-cancel" })).resolves.toBeUndefined()
	})

	it("rejects loaded sessions with no model", async () => {
		const fake = new FakeAgentSession("loaded-no-model")
		fake.model = undefined
		fake.branch = []
		const agent = makeAgent(async () => asSession(fake))
		await expect(
			agent.loadSession({
				sessionId: "loaded-no-model",
				cwd: "/tmp",
				mcpServers: [],
			}),
		).rejects.toMatchObject({ code: -32000 })
		expect(fake.disposed).toBe(true)
	})

	it("registers the loaded session so a follow-up prompt is accepted", async () => {
		const fake = new FakeAgentSession("loaded-prompt")
		fake.branch = [userTextEntry("prior", "u1", null)]
		const agent = makeAgent(async () => asSession(fake))
		await agent.loadSession({
			sessionId: "loaded-prompt",
			cwd: "/tmp",
			mcpServers: [],
		})
		// Drive a turn through the loaded session — short-circuit path is fine,
		// we just need to confirm prompt() doesn't reject with "unknown
		// sessionId" (which would mean the load registration failed).
		fake.promptImpl = async () => {}
		const res = await agent.prompt({
			sessionId: "loaded-prompt",
			prompt: [{ type: "text", text: "follow up" }],
		})
		expect(res.stopReason).toBe("end_turn")
	})

	// Per ToolKind: replayed tool calls should produce the same shape as live
	// turns — an initial tool_call carrying the kind/title/locations, followed
	// by a single terminal tool_call_update that pins status + content. This
	// matrix locks in describeToolCall coverage on the replay path so a future
	// kind addition doesn't silently bypass replay.
	const toolKindMatrix: Array<{
		name: string
		toolName: string
		args: Record<string, unknown>
		result: { text: string; isError?: boolean }
		expect: {
			kind: string
			title: string
			status: string
			locations: Array<{ path: string }>
		}
	}> = [
		{
			name: "bash → execute",
			toolName: "bash",
			args: { command: "ls -la" },
			result: { text: "ok" },
			expect: {
				kind: "execute",
				title: "ls -la",
				status: "completed",
				locations: [],
			},
		},
		{
			name: "read → read with location",
			toolName: "read",
			args: { file_path: "/tmp/a.ts" },
			result: { text: "contents" },
			expect: {
				kind: "read",
				title: "/tmp/a.ts",
				status: "completed",
				locations: [{ path: "/tmp/a.ts" }],
			},
		},
		{
			name: "edit → edit with location",
			toolName: "edit",
			args: { file_path: "/tmp/b.ts" },
			result: { text: "edited" },
			expect: {
				kind: "edit",
				title: "/tmp/b.ts",
				status: "completed",
				locations: [{ path: "/tmp/b.ts" }],
			},
		},
		{
			name: "grep → search",
			toolName: "grep",
			args: { pattern: "foo" },
			result: { text: "match" },
			expect: {
				kind: "search",
				title: "foo",
				status: "completed",
				locations: [],
			},
		},
		{
			name: "ls → read",
			toolName: "ls",
			args: { path: "/tmp" },
			result: { text: "listing" },
			expect: {
				kind: "read",
				title: "/tmp",
				status: "completed",
				locations: [{ path: "/tmp" }],
			},
		},
		{
			name: "find → search",
			toolName: "find",
			args: { pattern: "*.ts" },
			result: { text: "found" },
			expect: {
				kind: "search",
				title: "*.ts",
				status: "completed",
				locations: [],
			},
		},
		{
			name: "web_fetch → fetch",
			toolName: "web_fetch",
			args: { url: "https://example.com" },
			result: { text: "html" },
			expect: {
				kind: "fetch",
				title: "web_fetch",
				status: "completed",
				locations: [],
			},
		},
		{
			name: "Agent → think",
			toolName: "Agent",
			args: { prompt: "go" },
			result: { text: "done" },
			expect: {
				kind: "think",
				title: "Agent",
				status: "completed",
				locations: [],
			},
		},
		{
			name: "unknown tool → other",
			toolName: "mcp__foo__bar",
			args: { arg: 1 },
			result: { text: "ok" },
			expect: {
				kind: "other",
				title: "mcp__foo__bar",
				status: "completed",
				locations: [],
			},
		},
	]
	for (const c of toolKindMatrix) {
		it(`replays tool call (${c.name}) as tool_call + terminal tool_call_update`, async () => {
			const fake = new FakeAgentSession(`loaded-tool-${c.toolName}`)
			fake.branch = [
				userTextEntry("go", "u1", null),
				assistantBlocksEntry(
					[
						{
							type: "toolCall",
							id: "tc-1",
							name: c.toolName,
							arguments: c.args,
						},
					],
					"a1",
					"u1",
				),
				toolResultEntry("tc-1", c.toolName, c.result.text, c.result.isError ?? false, "tr1", "a1"),
			]
			const { conn, updates } = makeRecordingConn()
			const agent = makeAgent(async () => asSession(fake), { conn })
			await agent.loadSession({
				sessionId: fake.sessionId,
				cwd: "/tmp",
				mcpServers: [],
			})
			const seq = replayOnly(updates).map((u) => u.update.sessionUpdate)
			expect(seq).toEqual(["user_message_chunk", "tool_call", "tool_call_update"])

			const replay = replayOnly(updates)
			const toolCall = replay[1].update as Record<string, unknown>
			expect(toolCall).toMatchObject({
				sessionUpdate: "tool_call",
				toolCallId: `kt.${c.toolName}.0`,
				kind: c.expect.kind,
				title: c.expect.title,
				status: c.expect.status,
				locations: c.expect.locations,
				rawInput: c.args,
			})
			const update = replay[2].update as Record<string, unknown>
			expect(update).toMatchObject({
				sessionUpdate: "tool_call_update",
				toolCallId: `kt.${c.toolName}.0`,
				status: c.expect.status,
			})
			const content = (update as { content: Array<{ content: { text: string } }> }).content
			expect(content[0].content.text).toBe(c.result.text)
		})
	}

	it("replays a denied/failed tool call with status failed and the persisted error content", async () => {
		const fake = new FakeAgentSession("loaded-tool-fail")
		fake.branch = [
			userTextEntry("go", "u1", null),
			assistantBlocksEntry(
				[
					{
						type: "toolCall",
						id: "tc-deny",
						name: "bash",
						arguments: { command: "rm -rf /" },
					},
				],
				"a1",
				"u1",
			),
			toolResultEntry("tc-deny", "bash", "permission denied", true, "tr1", "a1"),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({
			sessionId: "loaded-tool-fail",
			cwd: "/tmp",
			mcpServers: [],
		})
		const replay = replayOnly(updates)
		const toolCall = replay[1].update as { status?: string }
		const update = replay[2].update as {
			status?: string
			content: Array<{ content: { text: string } }>
		}
		expect(toolCall.status).toBe("failed")
		expect(update.status).toBe("failed")
		expect(update.content[0].content.text).toBe("permission denied")
	})

	it("replays an interrupted tool call (no persisted result) as failed with empty content", async () => {
		// Session was killed mid tool execution; the tool result never landed in
		// the JSONL. "failed" is the only honest terminal status we can synthesize
		// — leaving it in_progress would hang the client's spinner forever.
		const fake = new FakeAgentSession("loaded-tool-orphan")
		fake.branch = [
			userTextEntry("go", "u1", null),
			assistantBlocksEntry(
				[
					{
						type: "toolCall",
						id: "tc-orphan",
						name: "bash",
						arguments: { command: "sleep 100" },
					},
				],
				"a1",
				"u1",
			),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({
			sessionId: "loaded-tool-orphan",
			cwd: "/tmp",
			mcpServers: [],
		})
		expect(replayOnly(updates).map((u) => u.update.sessionUpdate)).toEqual([
			"user_message_chunk",
			"tool_call",
			"tool_call_update",
		])
		const replay = replayOnly(updates)
		const toolCall = replay[1].update as { status?: string }
		const update = replay[2].update as { status?: string; content: unknown[] }
		expect(toolCall.status).toBe("failed")
		expect(update.status).toBe("failed")
		expect(update.content).toEqual([])
	})

	it("replays thinking blocks as agent_thought_chunk with raw text (no ANSI)", async () => {
		const fake = new FakeAgentSession("loaded-thinking")
		fake.branch = [
			userTextEntry("go", "u1", null),
			assistantBlocksEntry([{ type: "thinking", thinking: "considering options" }], "a1", "u1"),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({
			sessionId: "loaded-thinking",
			cwd: "/tmp",
			mcpServers: [],
		})
		const thought = updates.find((u) => u.update.sessionUpdate === "agent_thought_chunk")
		expect(thought).toBeDefined()
		const content = (thought?.update as { content: { type: string; text: string } }).content
		expect(content.text).toBe("considering options")
		// No ANSI escape codes — filterThinkingForDisplay returns dimmed text
		// for live TUI rendering, but ACP clients can't render escapes. Replay
		// uses the helper as a yes/no predicate and emits the raw thinking.
		expect(content.text.includes("\x1b[")).toBe(false)
	})

	it("skips redacted thinking blocks", async () => {
		// Redacted thinking has only an opaque encrypted payload (in
		// thinkingSignature) for multi-turn provider continuity — no plaintext
		// to surface to the user.
		const fake = new FakeAgentSession("loaded-thinking-redacted")
		fake.branch = [
			userTextEntry("go", "u1", null),
			assistantBlocksEntry(
				[
					{
						type: "thinking",
						thinking: "ignored",
						redacted: true,
						thinkingSignature: "opaque",
					},
				],
				"a1",
				"u1",
			),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({
			sessionId: "loaded-thinking-redacted",
			cwd: "/tmp",
			mcpServers: [],
		})
		expect(updates.find((u) => u.update.sessionUpdate === "agent_thought_chunk")).toBeUndefined()
	})

	it("emits zero notifications for compaction / branch_summary / model_change / custom entries", async () => {
		// Non-message entries are LLM-context artifacts (or, for model_change,
		// already conveyed via the load response's models field). Surfacing
		// them as session updates would make Zed's transcript UI churn through
		// historical state changes the user never saw the first time around.
		const fake = new FakeAgentSession("loaded-skip-only")
		fake.branch = [
			{
				type: "model_change",
				id: "mc1",
				parentId: null,
				timestamp: "x",
				provider: "p",
				modelId: "m",
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "mc1",
				timestamp: "x",
				summary: "snip",
				firstKeptEntryId: "u1",
				tokensBefore: 0,
			},
			{
				type: "branch_summary",
				id: "bs1",
				parentId: "c1",
				timestamp: "x",
				summary: "branch",
			},
			{
				type: "custom",
				id: "cu1",
				parentId: "bs1",
				timestamp: "x",
				payload: { whatever: true },
			},
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({
			sessionId: "loaded-skip-only",
			cwd: "/tmp",
			mcpServers: [],
		})

		// The only update expected here is a no-op surface commands update
		expect(updates).toHaveLength(1)
		expect(updates[0].update.sessionUpdate).toEqual("available_commands_update")
	})

	it("replays a mixed transcript end-to-end (text, thinking, tool, skipped entries, follow-up text)", async () => {
		const fake = new FakeAgentSession("loaded-mixed")
		fake.branch = [
			userTextEntry("question", "u1", null),
			assistantBlocksEntry(
				[
					{ type: "text", text: "let me check" },
					{ type: "thinking", thinking: "weighing options" },
					{
						type: "toolCall",
						id: "tc-1",
						name: "bash",
						arguments: { command: "ls" },
					},
				],
				"a1",
				"u1",
			),
			toolResultEntry("tc-1", "bash", "file1\nfile2", false, "tr1", "a1"),
			// Skipped entries scattered through the branch must not break the walker.
			{
				type: "model_change",
				id: "mc1",
				parentId: "tr1",
				timestamp: "x",
				provider: "p",
				modelId: "m",
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "mc1",
				timestamp: "x",
				summary: "snip",
				firstKeptEntryId: "u1",
				tokensBefore: 0,
			},
			assistantTextEntry("here is what I found", "a2", "c1"),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({
			sessionId: "loaded-mixed",
			cwd: "/tmp",
			mcpServers: [],
		})
		// Order is significant: tool_call must precede tool_call_update, and
		// the post-skipped-entries assistant text must land last.
		expect(updates.map((u) => u.update.sessionUpdate)).toEqual([
			"user_message_chunk",
			"agent_message_chunk",
			"agent_thought_chunk",
			"tool_call",
			"tool_call_update",
			"agent_message_chunk",
			"available_commands_update",
		])
	})

	it("does not deliver synthetic agent_* events to session subscribers during replay", async () => {
		// Acceptance criterion from the plan: extensions registered on a loaded
		// session must not see the historical turns as if they were live —
		// otherwise telemetry/loop-guard/etc. would double-count. Replay sends
		// notifications straight to conn.sessionUpdate, never via emit().
		const fake = new FakeAgentSession("loaded-no-events")
		fake.branch = [
			userTextEntry("hi", "u1", null),
			assistantBlocksEntry(
				[
					{ type: "text", text: "hello" },
					{ type: "thinking", thinking: "thinking" },
					{
						type: "toolCall",
						id: "tc-1",
						name: "bash",
						arguments: { command: "ls" },
					},
				],
				"a1",
				"u1",
			),
			toolResultEntry("tc-1", "bash", "out", false, "tr1", "a1"),
		]
		// Pre-subscribe a counter BEFORE loadSession so it sits alongside the
		// agent's own subscriber; if replay went through the event emitter we'd
		// see agent_start / message_update / tool_execution_* / agent_end here.
		let extensionEventCount = 0
		fake.subscribe(() => {
			extensionEventCount++
		})
		const agent = makeAgent(async () => asSession(fake))
		await agent.loadSession({
			sessionId: "loaded-no-events",
			cwd: "/tmp",
			mcpServers: [],
		})
		expect(extensionEventCount).toBe(0)
	})

	it("replays a 200-turn session well within a generous bound (regression guard)", async () => {
		// Regression guard against quadratic walker behavior. The fake skips
		// disk I/O and JSON-RPC framing — what's actually under test is that
		// the walker stays O(N). Bound is loose (3s) because shared CI runners
		// are noisy; a real regression would blow past it by orders of
		// magnitude.
		const fake = new FakeAgentSession("loaded-perf")
		const branch: unknown[] = []
		for (let i = 0; i < 200; i++) {
			branch.push(userTextEntry(`q${i}`, `u${i}`, i === 0 ? null : `a${i - 1}`))
			branch.push(
				assistantBlocksEntry(
					[
						{ type: "text", text: `a${i}` },
						{
							type: "toolCall",
							id: `tc-${i}`,
							name: "bash",
							arguments: { command: `echo ${i}` },
						},
					],
					`a${i}`,
					`u${i}`,
				),
			)
			branch.push(toolResultEntry(`tc-${i}`, "bash", `out${i}`, false, `tr-${i}`, `a${i}`))
		}
		fake.branch = branch
		const agent = makeAgent(async () => asSession(fake))
		const start = Date.now()
		await agent.loadSession({
			sessionId: "loaded-perf",
			cwd: "/tmp",
			mcpServers: [],
		})
		const elapsed = Date.now() - start
		expect(elapsed).toBeLessThan(3000)
	})
})

describe("KimchiAcpAgent permission mode session-log persistence", () => {
	function makeAgent(loader: AcpSessionLoader): KimchiAcpAgent {
		return new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(new FakeAgentSession("unused")),
			sessionLoader: loader,
		})
	}

	function makePermissionModeEntry(mode: string): {
		type: "custom"
		customType: string
		data: { mode: string; source: string; initiatedBy: string }
	} {
		return {
			type: "custom",
			customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
			data: { mode, source: "runtime", initiatedBy: "user" },
		}
	}

	it("loadSession restores the last persisted permission mode", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const fake = new FakeAgentSession("loaded-plan-mode")
		fake.branch = [makePermissionModeEntry("plan")]

		const agent = makeAgent(async () => asSession(fake))
		const res = await agent.loadSession({ sessionId: "loaded-plan-mode", cwd: "/tmp", mcpServers: [] })

		expect(res.configOptions?.[0].currentValue).toBe("plan")
		expect(getSessionPermissionFlagController("loaded-plan-mode")?.getMode()).toEqual({
			mode: "plan",
			source: "runtime",
			initiatedBy: "user",
		})
	})

	it("env var beats persisted mode when loading a session", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "yolo")

		const fake = new FakeAgentSession("loaded-auto-mode")
		fake.branch = [makePermissionModeEntry("auto")]

		const agent = makeAgent(async () => asSession(fake))
		const res = await agent.loadSession({ sessionId: "loaded-auto-mode", cwd: "/tmp", mcpServers: [] })

		expect(res.configOptions?.[0].currentValue).toBe("yolo")
	})

	it("setSessionConfigOption persists the mode to the session log", async () => {
		const fake = new FakeAgentSession("persist-mode", "/tmp")
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})

		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		await agent.setSessionConfigOption({
			sessionId: "persist-mode",
			configId: "permissions-mode",
			value: "plan",
		})

		const modeEntries = (fake.branch as Array<{ type: string; customType: string; data: { mode: string } }>).filter(
			(e) => e.type === "custom" && e.customType === PERMISSION_MODE_SESSION_ENTRY_TYPE,
		)
		// Only the user-driven plan change is persisted; newSession does not log
		// the resolved initial mode.
		expect(modeEntries).toHaveLength(1)
		expect(modeEntries.at(-1)?.data.mode).toBe("plan")
	})

	it("setSessionConfigOption does not write duplicate permission_mode entries", async () => {
		const fake = new FakeAgentSession("persist-mode-dup", "/tmp")
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})

		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		await agent.setSessionConfigOption({
			sessionId: "persist-mode-dup",
			configId: "permissions-mode",
			value: "plan",
		})
		await agent.setSessionConfigOption({
			sessionId: "persist-mode-dup",
			configId: "permissions-mode",
			value: "plan",
		})

		const modeEntries = (fake.branch as Array<{ type: string; customType: string; data: { mode: string } }>).filter(
			(e) => e.type === "custom" && e.customType === PERMISSION_MODE_SESSION_ENTRY_TYPE,
		)
		// Only the user-driven plan change is persisted; the duplicate plan call
		// must not add another entry.
		expect(modeEntries).toHaveLength(1)
	})

	it("newSession does not persist the resolved initial mode to the session log", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const fake = new FakeAgentSession("new-session-persist", "/tmp")
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})

		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const modeEntries = (fake.branch as Array<{ type: string; customType: string; data: { mode: string } }>).filter(
			(e) => e.type === "custom" && e.customType === PERMISSION_MODE_SESSION_ENTRY_TYPE,
		)
		expect(modeEntries).toHaveLength(0)
	})

	it("loadSession does not persist the resolved initial mode when no prior entry exists", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const fake = new FakeAgentSession("load-session-persist", "/tmp")
		fake.branch = []
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(new FakeAgentSession("unused")),
			sessionLoader: async () => asSession(fake),
		})

		await agent.loadSession({ sessionId: "load-session-persist", cwd: "/tmp", mcpServers: [] })

		const modeEntries = (fake.branch as Array<{ type: string; customType: string; data: { mode: string } }>).filter(
			(e) => e.type === "custom" && e.customType === PERMISSION_MODE_SESSION_ENTRY_TYPE,
		)
		expect(modeEntries).toHaveLength(0)
	})

	it("subagent inherits the parent session mode via the per-session env key", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const parentSessionId = "parent-acp-session"
		const childSessionId = "child-acp-session"
		process.env[PARENT_SESSION_ID_ENV_KEY] = parentSessionId
		process.env[getPermissionModeEnvKey(parentSessionId)] = "plan"

		const fake = new FakeAgentSession(childSessionId, "/tmp")
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})

		try {
			await agent.newSession({ cwd: "/tmp", mcpServers: [] })

			expect(getSessionPermissionFlagController(childSessionId)?.getMode()).toEqual({
				mode: "plan",
				source: "runtime",
				initiatedBy: "user",
			})
		} finally {
			Reflect.deleteProperty(process.env, PARENT_SESSION_ID_ENV_KEY)
			Reflect.deleteProperty(process.env, getPermissionModeEnvKey(parentSessionId))
		}
	})

	it("parent per-session env key takes precedence over child session log", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const parentSessionId = "parent-acp-session-2"
		const childSessionId = "child-acp-session-2"
		process.env[PARENT_SESSION_ID_ENV_KEY] = parentSessionId
		process.env[getPermissionModeEnvKey(parentSessionId)] = "yolo"

		const fake = new FakeAgentSession(childSessionId, "/tmp")
		fake.branch = [makePermissionModeEntry("plan")]
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})

		try {
			await agent.newSession({ cwd: "/tmp", mcpServers: [] })

			expect(getSessionPermissionFlagController(childSessionId)?.getMode()).toEqual({
				mode: "yolo",
				source: "runtime",
				initiatedBy: "user",
			})
		} finally {
			Reflect.deleteProperty(process.env, PARENT_SESSION_ID_ENV_KEY)
			Reflect.deleteProperty(process.env, getPermissionModeEnvKey(parentSessionId))
		}
	})

	it("changing mode in one session does not affect another session", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(new FakeAgentSession(`multi-session-${Date.now()}-${Math.random()}`)),
		})

		const session1 = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		const session2 = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		const session2InitialValue = session2.configOptions?.[0].currentValue

		const res1 = await agent.setSessionConfigOption({
			sessionId: session1.sessionId,
			configId: "permissions-mode",
			value: "plan",
		})

		expect(res1.configOptions?.[0].currentValue).toBe("plan")
		expect(session2InitialValue).toBe("default")
		expect(getSessionPermissionFlagController(session2.sessionId)?.getMode().mode).toBe("default")
	})

	it("close and reload a session restores the last persisted mode", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const sessionId = "close-reload-mode"
		const fake = new FakeAgentSession(sessionId, "/tmp")
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
			sessionLoader: async () => asSession(fake),
		})

		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		await agent.setSessionConfigOption({
			sessionId,
			configId: "permissions-mode",
			value: "plan",
		})
		await agent.unstable_closeSession({ sessionId })

		const loaded = await agent.loadSession({ sessionId, cwd: "/tmp", mcpServers: [] })
		expect(loaded.configOptions?.[0].currentValue).toBe("plan")
		expect(getSessionPermissionFlagController(sessionId)?.getMode()).toEqual({
			mode: "plan",
			source: "runtime",
			initiatedBy: "user",
		})
	})
})

// Ordering regression test: permission flag controller must be registered
// BEFORE bindAcpExtensions is called. This ensures that when upstream
// bindExtensions() emits session_start, the permissions extension already
// has access to the shared controller and doesn't create a duplicate one.
describe("KimchiAcpAgent permission flag controller registration ordering", () => {
	it("registers permission flag controller before bindAcpExtensions in newSession", async () => {
		const ordering: string[] = []
		const fake = new FakeAgentSession("session-ordering-test")

		fake.bindExtensionsImpl = async () => {
			// At this point, the permission controller should already be registered
			const controller = getSessionPermissionFlagController("session-ordering-test")
			ordering.push(controller ? "controller-present" : "controller-missing")
			ordering.push("bindAcpExtensions-called")
		}

		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})

		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		// The controller should be present when bindAcpExtensions is called
		expect(ordering).toEqual(["controller-present", "bindAcpExtensions-called"])
		// And should still be registered after newSession completes
		expect(getSessionPermissionFlagController("session-ordering-test")).toBeDefined()

		await agent.shutdown()
	})

	it("registers permission flag controller before bindAcpExtensions in loadSessionFresh", async () => {
		const ordering: string[] = []
		const fake = new FakeAgentSession("load-session-ordering")
		// Add a minimal branch for replay
		fake.branch = [
			{
				type: "message",
				message: { role: "user", content: "test" },
				timestamp: Date.now(),
			},
		]

		fake.bindExtensionsImpl = async () => {
			const controller = getSessionPermissionFlagController("load-session-ordering")
			ordering.push(controller ? "controller-present" : "controller-missing")
			ordering.push("bindAcpExtensions-called")
		}

		let loaderCallCount = 0
		const loader: AcpSessionLoader = async () => {
			loaderCallCount++
			return asSession(fake)
		}

		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionLoader: loader,
		})

		await agent.loadSession({
			sessionId: "load-session-ordering",
			cwd: "/tmp",
			mcpServers: [],
		})

		expect(loaderCallCount).toBe(1)
		expect(ordering).toEqual(["controller-present", "bindAcpExtensions-called"])
		expect(getSessionPermissionFlagController("load-session-ordering")).toBeDefined()

		await agent.shutdown()
	})

	it("unregisters permission flag controller when bindAcpExtensions throws in newSession", async () => {
		const fake = new FakeAgentSession("session-bind-failure")
		// Verify controller is registered during the call (before bind fails)
		let controllerDuringBind: ReturnType<typeof getSessionPermissionFlagController>
		fake.bindExtensionsImpl = async () => {
			controllerDuringBind = getSessionPermissionFlagController("session-bind-failure")
			throw new Error("bindExtensions failed")
		}

		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})

		await expect(agent.newSession({ cwd: "/tmp", mcpServers: [] })).rejects.toThrow(/bindExtensions failed/)

		// Controller should have been present during bind
		expect(controllerDuringBind).toBeDefined()
		// But should be unregistered after the catch block runs
		expect(getSessionPermissionFlagController("session-bind-failure")).toBeUndefined()
		expect(fake.disposed).toBe(true)
	})

	it("unregisters permission flag controller when bindAcpExtensions throws in loadSession", async () => {
		const fake = new FakeAgentSession("load-bind-failure")
		fake.branch = [
			{
				type: "message",
				message: { role: "user", content: "test" },
				timestamp: Date.now(),
			},
		]
		fake.bindExtensionsImpl = async () => {
			throw new Error("bindExtensions failed in load")
		}

		const loader: AcpSessionLoader = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionLoader: loader,
		})

		await expect(
			agent.loadSession({
				sessionId: "load-bind-failure",
				cwd: "/tmp",
				mcpServers: [],
			}),
		).rejects.toThrow(/bindExtensions failed in load/)

		expect(getSessionPermissionFlagController("load-bind-failure")).toBeUndefined()
		expect(fake.disposed).toBe(true)
	})

	it("provides a working controller that can get and set mode during bindAcpExtensions", async () => {
		const fake = new FakeAgentSession("session-controller-functional")
		let capturedMode: { mode: string; source: string } | undefined

		fake.bindExtensionsImpl = async () => {
			const controller = getSessionPermissionFlagController("session-controller-functional")
			if (controller) {
				// Verify the controller works - get initial mode
				capturedMode = controller.getMode()
				// Set a new mode
				controller.setMode({ mode: "plan", initiatedBy: "user", source: "runtime" })
			}
		}

		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})

		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		// The controller should be present and functional during bindExtensions
		expect(capturedMode).toBeDefined()
		expect(capturedMode?.mode).toBeDefined()
		expect(capturedMode?.source).toBeDefined()

		// After setMode in bindExtensions, the controller should have the new mode "plan"
		const finalController = getSessionPermissionFlagController("session-controller-functional")
		expect(finalController?.getMode()).toEqual({
			mode: "plan",
			source: "runtime",
			initiatedBy: "user",
		})

		await agent.shutdown()
	})
})

describe("KimchiAcpAgent session event handlers", () => {
	let fake: FakeAgentSession
	let agent: KimchiAcpAgent
	let sessionId: string
	let updates: SessionNotification[]

	beforeEach(async () => {
		fake = new FakeAgentSession("session-title")
		const { conn, updates: recorded } = makeRecordingConn()
		updates = recorded
		agent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(fake),
		})
		const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		sessionId = res.sessionId
		updates.length = 0 // clear the available_commands_update from newSession
	})

	describe("session_info_changed event", () => {
		it("emits session_info_update when session_info_changed fires with a name", () => {
			fake.emit({ type: "session_info_changed", name: "Fix the login bug" })

			const titleUpdates = updates.filter((u) => u.update.sessionUpdate === "session_info_update")
			expect(titleUpdates).toHaveLength(1)
			expect(titleUpdates[0]).toMatchObject({
				sessionId,
				update: {
					sessionUpdate: "session_info_update",
					title: "Fix the login bug",
				},
			})
		})

		it("does not emit session_info_update when name is undefined", () => {
			fake.emit({ type: "session_info_changed", name: undefined })

			const titleUpdates = updates.filter((u) => u.update.sessionUpdate === "session_info_update")
			expect(titleUpdates).toHaveLength(0)
		})

		it("emits the latest name when session_info_changed fires multiple times", () => {
			fake.emit({ type: "session_info_changed", name: "Draft title" })
			fake.emit({ type: "session_info_changed", name: "Final title" })

			const titleUpdates = updates.filter((u) => u.update.sessionUpdate === "session_info_update")
			expect(titleUpdates).toHaveLength(2)
			expect((titleUpdates[0].update as { title?: string }).title).toBe("Draft title")
			expect((titleUpdates[1].update as { title?: string }).title).toBe("Final title")
		})
	})
})

describe("stripAnsi", () => {
	it("returns unchanged text when no ANSI escapes are present", () => {
		expect(stripAnsi("plain text")).toBe("plain text")
	})
	it("removes CSI sequences (color, dim, reset) without touching surrounding text", () => {
		expect(stripAnsi("\x1b[2mfoo\x1b[22m bar")).toBe("foo bar")
		expect(stripAnsi("\x1b[31mred\x1b[0m and \x1b[1mbold\x1b[0m")).toBe("red and bold")
	})
	it("leaves a stray ESC byte (no full sequence) untouched", () => {
		// Conservative scrub: only `\x1b[…<letter>` is dropped. A bare ESC
		// without a CSI body isn't styling and shouldn't be mangled.
		expect(stripAnsi("plain\x1bbody")).toBe("plain\x1bbody")
	})
})

describe("userMessageText", () => {
	it("returns string content unchanged for user messages", () => {
		expect(userMessageText("hello world")).toBe("hello world")
	})
	it("joins text blocks and skips images for user messages", () => {
		expect(
			userMessageText([
				{ type: "text", text: "hi " },
				{ type: "image", data: "x", mimeType: "image/png" },
				{ type: "text", text: "there" },
			]),
		).toBe("hi there")
	})
	it("returns empty string for null / non-array user content", () => {
		expect(userMessageText(null)).toBe("")
		expect(userMessageText(42)).toBe("")
	})
})

describe("resolveAcpAppendSystemPrompt", () => {
	const noOptions = {}

	it("returns undefined when neither CLI flag nor ACP meta is present (backward compat)", () => {
		expect(resolveAcpAppendSystemPrompt({}, noOptions)).toBeUndefined()
		expect(resolveAcpAppendSystemPrompt({ _meta: {} }, noOptions)).toBeUndefined()
		expect(resolveAcpAppendSystemPrompt({ _meta: { "kimchi.dev": {} } }, noOptions)).toBeUndefined()
	})

	it("threads _meta['kimchi.dev'].appendSystemPrompt through for newSession", () => {
		const params = { _meta: { "kimchi.dev": { appendSystemPrompt: "You are a worker under AO supervision." } } }
		expect(resolveAcpAppendSystemPrompt(params, noOptions)).toEqual(["You are a worker under AO supervision."])
	})

	it("threads _meta['kimchi.dev'].appendSystemPrompt through identically for loadSession", () => {
		const params = { _meta: { "kimchi.dev": { appendSystemPrompt: "Loaded sessions get the same prompt." } } }
		expect(resolveAcpAppendSystemPrompt(params, noOptions)).toEqual(["Loaded sessions get the same prompt."])
	})

	it("appends meta content after CLI flag content when both are present", () => {
		const params = { _meta: { "kimchi.dev": { appendSystemPrompt: "meta prompt" } } }
		expect(resolveAcpAppendSystemPrompt(params, { appendSystemPrompt: ["cli one", "cli two"] })).toEqual([
			"cli one",
			"cli two",
			"meta prompt",
		])
	})

	it("returns CLI flag content unchanged when no meta is present", () => {
		expect(resolveAcpAppendSystemPrompt({}, { appendSystemPrompt: ["cli only"] })).toEqual(["cli only"])
	})

	it("ignores non-string, empty, and whitespace-only meta appendSystemPrompt values", () => {
		expect(
			resolveAcpAppendSystemPrompt({ _meta: { "kimchi.dev": { appendSystemPrompt: 42 } } }, noOptions),
		).toBeUndefined()
		expect(
			resolveAcpAppendSystemPrompt({ _meta: { "kimchi.dev": { appendSystemPrompt: "" } } }, noOptions),
		).toBeUndefined()
		expect(
			resolveAcpAppendSystemPrompt({ _meta: { "kimchi.dev": { appendSystemPrompt: "   \n  " } } }, noOptions),
		).toBeUndefined()
	})

	it("ignores the plain systemPrompt key — the meta value appends, it never replaces", () => {
		// The plain `systemPrompt` name is reserved: if a replace-the-system-prompt
		// API is ever exposed over _meta, it gets its own distinctly named key.
		expect(
			resolveAcpAppendSystemPrompt({ _meta: { "kimchi.dev": { systemPrompt: "ignored" } } }, noOptions),
		).toBeUndefined()
	})

	it("tolerates non-object _meta and non-object kimchi.dev payloads", () => {
		expect(resolveAcpAppendSystemPrompt({ _meta: "nope" }, noOptions)).toBeUndefined()
		expect(resolveAcpAppendSystemPrompt({ _meta: { "kimchi.dev": "nope" } }, noOptions)).toBeUndefined()
		expect(resolveAcpAppendSystemPrompt({ _meta: null }, noOptions)).toBeUndefined()
	})
})
