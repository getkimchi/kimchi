import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@earendil-works/pi-coding-agent", async () => {
	return {
		DefaultResourceLoader: vi.fn().mockImplementation(() => ({
			reload: vi.fn().mockResolvedValue(undefined),
		})),
		SessionManager: {
			inMemory: vi.fn().mockReturnValue({}),
			open: vi.fn().mockReturnValue({}),
		},
		SettingsManager: {
			create: vi.fn().mockReturnValue({ applyOverrides: vi.fn() }),
		},
		createAgentSession: vi.fn(),
		getAgentDir: vi.fn().mockReturnValue("/fake-agent-dir"),
	}
})

vi.mock("../../env.js", () => ({
	detectEnv: vi.fn().mockResolvedValue({ os: "linux", shell: "bash" }),
}))

vi.mock("../prompt/prompts.js", () => ({
	buildAgentPrompt: vi.fn().mockReturnValue("System prompt text"),
	formatTokenBudget: vi.fn().mockImplementation((n: number) => {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
		if (n >= 1_000) return `${Math.round(n / 1_000)}k`
		return String(n)
	}),
}))

vi.mock("../prompt/skill-loader.js", () => ({
	preloadSkills: vi.fn().mockReturnValue([]),
}))

vi.mock("../prompt/context.js", () => ({
	buildParentContext: vi.fn().mockReturnValue(undefined),
	extractText: vi.fn().mockImplementation((content: unknown) => {
		if (typeof content === "string") return content
		if (Array.isArray(content)) {
			return (content as Array<{ type: string; text?: string }>)
				.filter((c) => c.type === "text" && c.text)
				.map((c) => c.text)
				.join("")
		}
		return ""
	}),
}))

vi.mock("../personas/agent-types.js", () => ({
	BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	getConfig: vi.fn().mockReturnValue({
		extensions: false,
		skills: false,
	}),
	getAgentConfig: vi.fn().mockReturnValue({
		name: "General-Purpose",
		description: "General purpose agent",
		thinking: undefined,
		maxTurns: undefined,
		memory: undefined,
		disallowedTools: undefined,
		roles: undefined,
		models: undefined,
	}),
	getToolNamesForType: vi.fn().mockReturnValue([]),
	getMemoryToolNames: vi.fn().mockReturnValue([]),
	getReadOnlyMemoryToolNames: vi.fn().mockReturnValue([]),
}))

vi.mock("../personas/default-agents.js", () => ({
	DEFAULT_AGENTS: new Map(),
}))

vi.mock("../../tags.js", () => ({
	getCurrentPhase: vi.fn().mockReturnValue(undefined),
	setCurrentPhase: vi.fn(),
}))

vi.mock("../../memory/memory.js", () => ({
	buildMemoryBlock: vi.fn().mockReturnValue(""),
	buildReadOnlyMemoryBlock: vi.fn().mockReturnValue(""),
}))

vi.mock("../../prompt-construction/context-files.js", () => ({
	loadProjectContextFiles: vi.fn().mockReturnValue([]),
}))

vi.mock("../../telemetry/index.js", () => ({
	default: vi.fn().mockReturnValue(() => {}),
}))

vi.mock("../../../config.js", () => ({
	loadConfig: vi.fn().mockReturnValue({ retry: { maxRetries: 10 } }),
	readTelemetryConfig: vi.fn().mockReturnValue({
		enabled: true,
		endpoint: "https://test/logs",
		metricsEndpoint: "https://test/metrics",
		headers: { Authorization: "Bearer test" },
		apiKey: "",
	}),
}))

vi.mock("../../orchestration/model-registry/guidelines/guidelines-resolver.js", () => ({
	buildPhaseGuidelinesSection: vi.fn().mockReturnValue(""),
}))

import {
	type AgentSession,
	type CreateAgentSessionResult,
	DefaultResourceLoader,
	createAgentSession,
} from "@earendil-works/pi-coding-agent"
import { readTelemetryConfig } from "../../../config.js"
import { FERMENT_TOOL_NAMES } from "../../ferment/tool-names.js"
import { buildPhaseGuidelinesSection } from "../../orchestration/model-registry/guidelines/guidelines-resolver.js"
import { loadProjectContextFiles } from "../../prompt-construction/context-files.js"
import telemetryExtension from "../../telemetry/index.js"
import { getAgentConfig, getConfig, getToolNamesForType } from "../personas/agent-types.js"
import { buildAgentPrompt } from "../prompt/prompts.js"
import { type RunOptions, runAgent } from "./agent-runner.js"
import { PARENT_SESSION_ID_ENV_KEY } from "./constants.js"

const mockCreateAgentSession = vi.mocked(createAgentSession)
const mockGetConfig = vi.mocked(getConfig)
const mockGetAgentConfig = vi.mocked(getAgentConfig)
const mockGetToolNamesForType = vi.mocked(getToolNamesForType)
const mockLoadProjectContextFiles = vi.mocked(loadProjectContextFiles)
const mockBuildAgentPrompt = vi.mocked(buildAgentPrompt)
const mockBuildPhaseGuidelinesSection = vi.mocked(buildPhaseGuidelinesSection)
const mockDefaultResourceLoader = vi.mocked(DefaultResourceLoader)
const mockTelemetryExtension = vi.mocked(telemetryExtension)
const mockReadTelemetryConfig = vi.mocked(readTelemetryConfig)

type SessionEvent = { type: string; [k: string]: unknown }
type Subscriber = (event: SessionEvent) => void

const DEFAULT_REGISTERED_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"]

function makeFakeSession({
	promptTokens = 0,
	outputTokens = 0,
	cacheReadTokens = 0,
	cacheWriteTokens = 0,
	abortSpy = vi.fn(),
	emitUsage = true,
	events,
	statsTokens,
	activeToolNames = [],
	registeredToolNames,
}: {
	promptTokens?: number
	outputTokens?: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
	abortSpy?: ReturnType<typeof vi.fn>
	emitUsage?: boolean
	events?: SessionEvent[]
	statsTokens?: { input: number; output: number; cacheRead: number; cacheWrite: number }
	activeToolNames?: string[]
	registeredToolNames?: string[]
} = {}) {
	const subscribers: Subscriber[] = []
	let promptCalled = false
	const registeredTools = new Set(registeredToolNames ?? [...DEFAULT_REGISTERED_TOOL_NAMES, ...activeToolNames])
	const sessionStatsTokens =
		statsTokens ??
		({
			input: promptTokens,
			output: outputTokens,
			cacheRead: cacheReadTokens,
			cacheWrite: cacheWriteTokens,
		} as { input: number; output: number; cacheRead: number; cacheWrite: number })

	const session = {
		subscribe: vi.fn((cb: Subscriber) => {
			subscribers.push(cb)
			return () => {
				const idx = subscribers.indexOf(cb)
				if (idx !== -1) subscribers.splice(idx, 1)
			}
		}),
		abort: abortSpy,
		steer: vi.fn(),
		getActiveToolNames: vi.fn().mockReturnValue(activeToolNames),
		getToolDefinition: vi.fn((name: string) => (registeredTools.has(name) ? { name } : undefined)),
		setActiveToolsByName: vi.fn(),
		bindExtensions: vi.fn().mockResolvedValue(undefined),
		messages: [],
		getSessionStats: vi.fn().mockReturnValue({
			tokens: sessionStatsTokens,
		}),
		prompt: vi.fn().mockImplementation(async () => {
			if (!promptCalled) {
				promptCalled = true
				if (events) {
					for (const event of events) {
						for (const sub of subscribers) {
							sub(event)
						}
					}
					return
				}
				if (emitUsage) {
					for (const sub of subscribers) {
						sub({
							type: "message_end",
							message: {
								role: "assistant",
								usage: {
									input: promptTokens,
									output: outputTokens,
									cacheRead: cacheReadTokens,
									cacheWrite: cacheWriteTokens,
								},
							},
						})
					}
				}
				for (const sub of subscribers) {
					sub({ type: "turn_end" })
				}
			}
		}),
	}

	// Attach extensionRunner directly so callers can inspect it without destructuring.
	const fullSession = Object.assign(session, {
		extensionRunner: { emit: vi.fn().mockResolvedValue(true) },
	})
	return fullSession
}

function makeFakeCtx() {
	return {
		cwd: "/fake/cwd",
		model: undefined,
		modelRegistry: {
			find: vi.fn().mockReturnValue(undefined),
			getAvailable: vi.fn().mockReturnValue([]),
		},
		getSystemPrompt: vi.fn().mockReturnValue(""),
		sessionManager: {
			getSessionId: vi.fn().mockReturnValue("session-1"),
			getSessionDir: vi.fn().mockReturnValue(undefined),
			getSessionFile: vi.fn().mockReturnValue(undefined),
		},
	}
}

function makeFakePi() {
	return {
		exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
	}
}

function makeTypeConfig(overrides: Partial<ReturnType<typeof getConfig>> = {}): ReturnType<typeof getConfig> {
	return {
		displayName: "Agent",
		description: "Agent",
		builtinToolNames: [],
		extensions: false,
		skills: false,
		promptMode: "replace",
		...overrides,
	}
}

function makeAgentConfig(
	overrides: Partial<NonNullable<ReturnType<typeof getAgentConfig>>> = {},
): NonNullable<ReturnType<typeof getAgentConfig>> {
	return {
		name: "General-Purpose",
		description: "General purpose agent",
		extensions: false,
		skills: false,
		systemPrompt: "",
		promptMode: "replace",
		thinking: undefined,
		maxTurns: undefined,
		memory: undefined,
		disallowedTools: undefined,
		roles: undefined,
		models: undefined,
		...overrides,
	}
}

describe("runAgent — telemetry extension", () => {
	let ctx: ReturnType<typeof makeFakeCtx>
	let pi: ReturnType<typeof makeFakePi>

	beforeEach(() => {
		ctx = makeFakeCtx()
		pi = makeFakePi()
		mockCreateAgentSession.mockReset()
		mockDefaultResourceLoader.mockClear()
		mockTelemetryExtension.mockClear()
		mockReadTelemetryConfig.mockClear()
		mockGetConfig.mockReturnValue(makeTypeConfig({ extensions: false, skills: false }))
		mockGetAgentConfig.mockReturnValue(makeAgentConfig())
		mockGetToolNamesForType.mockReturnValue([])
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("passes telemetryExtension as extensionFactories to DefaultResourceLoader", async () => {
		const session = makeFakeSession({})
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(mockDefaultResourceLoader).toHaveBeenCalledTimes(1)
		const ctorArg = mockDefaultResourceLoader.mock.calls[0]?.[0]
		expect(ctorArg).toHaveProperty("extensionFactories")
		expect(Array.isArray(ctorArg?.extensionFactories)).toBe(true)
		expect(ctorArg?.extensionFactories).toHaveLength(1)
		expect(mockReadTelemetryConfig).toHaveBeenCalled()
		expect(mockTelemetryExtension).toHaveBeenCalledWith(mockReadTelemetryConfig.mock.results[0]?.value)
	})

	it("emits session_shutdown after prompt completes so telemetry flushes and timers are cleared", async () => {
		const session = makeFakeSession({})
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" })
	})
})

describe("runAgent — tokenBudget forwarding", () => {
	let ctx: ReturnType<typeof makeFakeCtx>
	let pi: ReturnType<typeof makeFakePi>

	beforeEach(() => {
		ctx = makeFakeCtx()
		pi = makeFakePi()
		mockCreateAgentSession.mockReset()
		mockGetConfig.mockReturnValue(
			makeTypeConfig({
				extensions: false,
				skills: false,
			}),
		)
		mockGetAgentConfig.mockReturnValue(makeAgentConfig())
		mockGetToolNamesForType.mockReturnValue([])
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("aborts the session when cumulative output token usage exceeds tokenBudget", async () => {
		const abortSpy = vi.fn()
		const session = makeFakeSession({
			promptTokens: 10_000,
			outputTokens: 5_000,
			abortSpy,
		})

		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		const result = await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
			tokenBudget: 4_999,
		})

		expect(abortSpy).toHaveBeenCalled()
		expect(result.aborted).toBe(true)
		expect(result.abortReason).toBe("token_budget")
	})

	it("does NOT count cacheWrite tokens toward tokenBudget", async () => {
		const abortSpy = vi.fn()
		const session = makeFakeSession({
			promptTokens: 8_000,
			outputTokens: 1_000,
			cacheWriteTokens: 4_000,
			abortSpy,
		})

		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		const result = await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
			tokenBudget: 4_999,
		})

		expect(abortSpy).not.toHaveBeenCalled()
		expect(result.aborted).toBe(false)
	})

	it("checks final session stats when message_end usage is not emitted", async () => {
		const abortSpy = vi.fn()
		const session = makeFakeSession({
			promptTokens: 10_000,
			outputTokens: 5_000,
			abortSpy,
			emitUsage: false,
		})

		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		const result = await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
			tokenBudget: 4_999,
		})

		expect(abortSpy).not.toHaveBeenCalled()
		expect(result.aborted).toBe(true)
		expect(result.abortReason).toBe("token_budget")
	})

	it("reconciles final session stats against the current post-compaction window", async () => {
		const abortSpy = vi.fn()
		const usageEvents: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number }> = []
		const session = makeFakeSession({
			abortSpy,
			statsTokens: { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0 },
			events: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						usage: { input: 9_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
					},
				},
				{
					type: "compaction_end",
					aborted: false,
					reason: "threshold",
					result: { tokensBefore: 10_000 },
				},
				{ type: "turn_end" },
			],
		})

		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		const result = await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
			tokenBudget: 1_499,
			onAssistantUsage: (usage) => usageEvents.push(usage),
		})

		expect(abortSpy).not.toHaveBeenCalled()
		expect(usageEvents).toEqual([
			{ input: 9_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
			{ input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0 },
		])
		expect(result.aborted).toBe(true)
		expect(result.abortReason).toBe("token_budget")
	})

	it("does NOT abort when token usage stays below tokenBudget", async () => {
		const abortSpy = vi.fn()
		const session = makeFakeSession({
			promptTokens: 1_000,
			outputTokens: 500,
			abortSpy,
		})

		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
			tokenBudget: 50_000,
		})

		expect(abortSpy).not.toHaveBeenCalled()
	})

	it("does NOT abort when tokenBudget is not set", async () => {
		const abortSpy = vi.fn()
		const session = makeFakeSession({
			promptTokens: 999_999,
			outputTokens: 999_999,
			abortSpy,
		})

		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(abortSpy).not.toHaveBeenCalled()
	})

	it("profile tokenBudget is used when no param overrides it", async () => {
		const { getAgentConfig } = await import("../personas/agent-types.js")
		vi.mocked(getAgentConfig).mockReturnValueOnce({
			name: "Explore",
			description: "Explore agent",
			thinking: undefined,
			maxTurns: undefined,
			memory: undefined,
			disallowedTools: undefined,
			roles: ["explore"],
			models: undefined,
			tokenBudget: 19_999,
			extensions: false,
			skills: false,
			promptMode: "replace",
			systemPrompt: "",
		} as unknown as ReturnType<typeof getAgentConfig>)

		const abortSpy = vi.fn()
		const session = makeFakeSession({ promptTokens: 30_000, outputTokens: 20_000, abortSpy })

		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		const result = await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Explore", "explore it", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(abortSpy).toHaveBeenCalled()
		expect(result.aborted).toBe(true)
		expect(result.abortReason).toBe("token_budget")
	})

	it("explicit tokenBudget param wins over profile tokenBudget (precedence)", async () => {
		const { getAgentConfig } = await import("../personas/agent-types.js")
		vi.mocked(getAgentConfig).mockReturnValueOnce({
			name: "Explore",
			description: "Explore agent",
			thinking: undefined,
			maxTurns: undefined,
			memory: undefined,
			disallowedTools: undefined,
			roles: ["explore"],
			models: undefined,
			tokenBudget: 100_000,
			extensions: false,
			skills: false,
			promptMode: "replace",
			systemPrompt: "",
		} as unknown as ReturnType<typeof getAgentConfig>)

		const abortSpy = vi.fn()
		const session = makeFakeSession({ promptTokens: 30_000, outputTokens: 20_000, abortSpy })

		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		const result = await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Explore", "explore it", {
			pi: pi as unknown as RunOptions["pi"],
			tokenBudget: 19_999,
		})

		expect(abortSpy).toHaveBeenCalled()
		expect(result.aborted).toBe(true)
		expect(result.abortReason).toBe("token_budget")
	})
})

describe("runAgent — profile tool access", () => {
	let ctx: ReturnType<typeof makeFakeCtx>
	let pi: ReturnType<typeof makeFakePi>

	beforeEach(() => {
		ctx = makeFakeCtx()
		pi = makeFakePi()
		mockCreateAgentSession.mockReset()
		mockGetConfig.mockReturnValue(
			makeTypeConfig({
				extensions: true,
				skills: false,
			}),
		)
		mockGetAgentConfig.mockReturnValue(
			makeAgentConfig({
				name: "Researcher",
				description: "Research agent",
				roles: ["research"],
			}),
		)
		mockGetToolNamesForType.mockReturnValue(["read", "grep"])
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("does not pass a hard tools allowlist when profile extensions are enabled", async () => {
		const session = makeFakeSession({
			activeToolNames: ["read", "grep", "edit", "web_search", "Agent", "steer_subagent"],
		})
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Researcher", "research it", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(mockCreateAgentSession).toHaveBeenCalledWith(expect.not.objectContaining({ tools: expect.anything() }))
		expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "grep", "web_search"])
	})

	it("activates requested builtin tools even when the parent session did not have them active", async () => {
		mockGetToolNamesForType.mockReturnValue(["read", "bash", "grep", "find", "ls"])
		const session = makeFakeSession({
			activeToolNames: ["read", "bash", "edit", "web_search", "Agent", "scope_ferment"],
		})
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Researcher", "research it", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "bash", "grep", "find", "ls", "web_search"])
		expect(mockBuildAgentPrompt.mock.calls.at(-1)?.[4]?.activeToolNames).toEqual([
			"read",
			"bash",
			"grep",
			"find",
			"ls",
			"web_search",
		])
	})

	it("omits requested tools that are absent from the subagent registry", async () => {
		mockGetToolNamesForType.mockReturnValue(["read", "grep", "missing_tool"])
		const session = makeFakeSession({
			activeToolNames: ["read", "web_search"],
			registeredToolNames: ["read", "web_search"],
		})
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Researcher", "research it", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "web_search"])
		expect(mockBuildAgentPrompt.mock.calls.at(-1)?.[4]?.activeToolNames).toEqual(["read", "web_search"])
	})

	it("keeps only matching extension tools when profile names an extension allowlist", async () => {
		mockGetConfig.mockReturnValue(
			makeTypeConfig({
				extensions: ["web"],
				skills: false,
			}),
		)
		const session = makeFakeSession({
			activeToolNames: ["read", "grep", "web_search", "mcp__db__query", "Agent"],
		})
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Researcher", "research it", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "grep", "web_search"])
	})

	it("strips all ferment tools from subagents regardless of registered extensions", async () => {
		// Subagents must not mutate ferment state (lifecycle, planning, discovery).
		// All ferment tool names are in EXCLUDED_TOOL_NAMES so they are filtered
		// out at session init regardless of which extensions are loaded.
		const fermentToolsInSession = [
			"scope_ferment",
			"activate_ferment_phase",
			"start_ferment_step",
			"list_ferments",
			"request_ferment_workflow",
		]
		const session = makeFakeSession({
			activeToolNames: ["read", "grep", "web_search", ...fermentToolsInSession],
		})
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Researcher", "research it", {
			pi: pi as unknown as RunOptions["pi"],
		})

		const calledWith = (session.setActiveToolsByName as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
		for (const name of FERMENT_TOOL_NAMES) {
			expect(calledWith, `ferment tool "${name}" must be excluded from subagents`).not.toContain(name)
		}
		expect(calledWith).toContain("read")
		expect(calledWith).toContain("grep")
		expect(calledWith).toContain("web_search")
	})
})

function turnEvents(outputTokens: number): SessionEvent[] {
	return [
		{
			type: "message_end",
			message: { role: "assistant", usage: { input: 1_000, output: outputTokens, cacheWrite: 0 } },
		},
		{ type: "turn_end" },
	]
}

function multiTurnEvents(turnCount: number, outputTokensPerTurn: number): SessionEvent[] {
	const events: SessionEvent[] = []
	for (let i = 0; i < turnCount; i++) {
		events.push(...turnEvents(outputTokensPerTurn))
	}
	return events
}

describe("runAgent — budget awareness steers", () => {
	let ctx: ReturnType<typeof makeFakeCtx>
	let pi: ReturnType<typeof makeFakePi>

	beforeEach(() => {
		ctx = makeFakeCtx()
		pi = makeFakePi()
		mockCreateAgentSession.mockReset()
		mockGetConfig.mockReturnValue(makeTypeConfig({ extensions: false, skills: false }))
		mockGetToolNamesForType.mockReturnValue([])
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	const steerCases: Record<string, { maxTurns: number; turns: number; expectedSteerCount: number; pattern?: RegExp }> =
		{
			"does not steer before 50% of turn budget": {
				maxTurns: 10,
				turns: 4,
				expectedSteerCount: 0,
			},
			"steers at 50% of turn budget": {
				maxTurns: 10,
				turns: 5,
				expectedSteerCount: 1,
				pattern: /\[Orchestrator — automated system instruction, not a user message\][\s\S]*50% of your turn budget./,
			},
			"does not steer between 50% and 75%": {
				maxTurns: 10,
				turns: 7,
				expectedSteerCount: 1,
			},
			"steers at 75% of turn budget": {
				maxTurns: 10,
				turns: 8,
				expectedSteerCount: 2,
				pattern: /\[Orchestrator — automated system instruction, not a user message\][\s\S]*75% of your turn budget./,
			},
			"steers at 90% of turn budget": {
				maxTurns: 10,
				turns: 9,
				expectedSteerCount: 3,
				pattern: /\[Orchestrator — automated system instruction, not a user message\][\s\S]*90% of your turn budget./,
			},
		}

	for (const [name, tc] of Object.entries(steerCases)) {
		it(name, async () => {
			mockGetAgentConfig.mockReturnValue(makeAgentConfig({ maxTurns: tc.maxTurns }))
			const session = makeFakeSession({ events: multiTurnEvents(tc.turns, 100) })
			mockCreateAgentSession.mockResolvedValue({
				session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
				extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
					ReturnType<typeof createAgentSession>
				>["extensionsResult"],
			})

			await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
				pi: pi as unknown as RunOptions["pi"],
			})

			const steerCalls = session.steer.mock.calls
			expect(steerCalls.length).toBe(tc.expectedSteerCount)
			if (tc.pattern && steerCalls.length > 0) {
				expect(steerCalls[steerCalls.length - 1]?.[0]).toMatch(tc.pattern)
			}
		})
	}

	it("steers at 80% of token budget before hard abort", async () => {
		mockGetAgentConfig.mockReturnValue(makeAgentConfig({ maxTurns: undefined }))
		const session = makeFakeSession({ events: multiTurnEvents(5, 2_000) })
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
			tokenBudget: 10_000,
		})

		const steerCalls = session.steer.mock.calls
		const tokenSteer = steerCalls.find((c: string[]) => c[0].includes("output token limit"))
		expect(tokenSteer).toBeDefined()
		expect(tokenSteer?.[0]).toMatch(/Budget check/)
	})

	it("does not token-steer when usage stays below 80%", async () => {
		mockGetAgentConfig.mockReturnValue(makeAgentConfig({ maxTurns: undefined }))
		const session = makeFakeSession({ events: multiTurnEvents(3, 1_000) })
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
			tokenBudget: 10_000,
		})

		const steerCalls = session.steer.mock.calls
		const tokenSteer = steerCalls.find((c: string[]) => c[0].includes("output token limit"))
		expect(tokenSteer).toBeUndefined()
	})
})

describe("runAgent — maxDuration enforcement", () => {
	let ctx: ReturnType<typeof makeFakeCtx>
	let pi: ReturnType<typeof makeFakePi>

	beforeEach(() => {
		vi.useFakeTimers()
		ctx = makeFakeCtx()
		pi = makeFakePi()
		mockCreateAgentSession.mockReset()
		mockGetConfig.mockReturnValue(makeTypeConfig({ extensions: false, skills: false }))
		mockGetAgentConfig.mockReturnValue(makeAgentConfig())
		mockGetToolNamesForType.mockReturnValue([])
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
	})

	const cases: Record<
		string,
		{
			maxDuration: number
			advanceMs: number
			expectAborted: boolean
			expectReason: string | undefined
		}
	> = {
		"aborts when wall-clock duration exceeds maxDuration": {
			maxDuration: 30,
			advanceMs: 31_000,
			expectAborted: true,
			expectReason: "max_duration",
		},
		"does not abort when duration stays within maxDuration": {
			maxDuration: 30,
			advanceMs: 10_000,
			expectAborted: false,
			expectReason: undefined,
		},
	}

	for (const [name, tc] of Object.entries(cases)) {
		it(name, async () => {
			const abortSpy = vi.fn()
			let resolvePrompt: (() => void) | undefined
			const promptPromise = new Promise<void>((resolve) => {
				resolvePrompt = resolve
			})

			const subscribers: Subscriber[] = []
			const session = {
				subscribe: vi.fn((cb: Subscriber) => {
					subscribers.push(cb)
					return () => {
						const idx = subscribers.indexOf(cb)
						if (idx !== -1) subscribers.splice(idx, 1)
					}
				}),
				abort: abortSpy.mockImplementation(() => {
					resolvePrompt?.()
				}),
				steer: vi.fn(),
				getActiveToolNames: vi.fn().mockReturnValue([]),
				setActiveToolsByName: vi.fn(),
				bindExtensions: vi.fn().mockResolvedValue(undefined),
				messages: [],
				getSessionStats: vi.fn().mockReturnValue({
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}),
				prompt: vi.fn().mockImplementation(async () => {
					await promptPromise
				}),
			}

			mockCreateAgentSession.mockResolvedValue({
				session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
				extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
					ReturnType<typeof createAgentSession>
				>["extensionsResult"],
			})

			const resultPromise = runAgent(
				ctx as unknown as Parameters<typeof runAgent>[0],
				"General-Purpose",
				"do something",
				{
					pi: pi as unknown as RunOptions["pi"],
					maxDuration: tc.maxDuration,
				},
			)

			await vi.advanceTimersByTimeAsync(tc.advanceMs)

			if (!tc.expectAborted) {
				resolvePrompt?.()
			}

			const result = await resultPromise

			if (tc.expectAborted) {
				expect(abortSpy).toHaveBeenCalled()
				expect(result.aborted).toBe(true)
				expect(result.abortReason).toBe(tc.expectReason)
			} else {
				expect(abortSpy).not.toHaveBeenCalled()
				expect(result.aborted).toBe(false)
			}
		})
	}

	it("uses agentConfig.maxDuration when no param override", async () => {
		mockGetAgentConfig.mockReturnValue(makeAgentConfig({ maxDuration: 20 }))
		const abortSpy = vi.fn()
		let resolvePrompt: (() => void) | undefined
		const promptPromise = new Promise<void>((resolve) => {
			resolvePrompt = resolve
		})

		const session = {
			subscribe: vi.fn((_cb: Subscriber) => {
				return () => {}
			}),
			abort: abortSpy.mockImplementation(() => {
				resolvePrompt?.()
			}),
			steer: vi.fn(),
			getActiveToolNames: vi.fn().mockReturnValue([]),
			setActiveToolsByName: vi.fn(),
			bindExtensions: vi.fn().mockResolvedValue(undefined),
			messages: [],
			getSessionStats: vi.fn().mockReturnValue({
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
			prompt: vi.fn().mockImplementation(async () => {
				await promptPromise
			}),
		}

		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		const resultPromise = runAgent(
			ctx as unknown as Parameters<typeof runAgent>[0],
			"General-Purpose",
			"do something",
			{
				pi: pi as unknown as RunOptions["pi"],
			},
		)

		await vi.advanceTimersByTimeAsync(21_000)
		const result = await resultPromise

		expect(abortSpy).toHaveBeenCalled()
		expect(result.aborted).toBe(true)
		expect(result.abortReason).toBe("max_duration")
	})
})

describe("runAgent — includeContextFiles", () => {
	let ctx: ReturnType<typeof makeFakeCtx>
	let pi: ReturnType<typeof makeFakePi>

	beforeEach(() => {
		ctx = makeFakeCtx()
		pi = makeFakePi()
		mockCreateAgentSession.mockReset()
		mockLoadProjectContextFiles.mockReset()
		mockBuildAgentPrompt.mockReset()
		mockBuildAgentPrompt.mockReturnValue("System prompt text")
		mockGetConfig.mockReturnValue(makeTypeConfig({ extensions: false, skills: false }))
		mockGetToolNamesForType.mockReturnValue([])
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("passes context files to buildAgentPrompt when includeContextFiles is true", async () => {
		const fakeContextFiles = [{ path: "/repo/AGENTS.md", content: "# Guidelines" }]
		mockLoadProjectContextFiles.mockReturnValue(fakeContextFiles)
		mockGetAgentConfig.mockReturnValue(
			makeAgentConfig({ name: "Plan", description: "Plan agent", includeContextFiles: true }),
		)

		mockCreateAgentSession.mockResolvedValue({
			session: makeFakeSession() as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Plan", "write a plan", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(mockLoadProjectContextFiles).toHaveBeenCalledWith(ctx.cwd)
		const extras = mockBuildAgentPrompt.mock.calls[0]?.[4]
		expect(extras?.contextFiles).toEqual(fakeContextFiles)
	})

	it("does not load context files when includeContextFiles is false", async () => {
		mockGetAgentConfig.mockReturnValue(
			makeAgentConfig({ name: "General-Purpose", description: "General purpose", includeContextFiles: false }),
		)

		mockCreateAgentSession.mockResolvedValue({
			session: makeFakeSession() as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(mockLoadProjectContextFiles).not.toHaveBeenCalled()
		const extras = mockBuildAgentPrompt.mock.calls[0]?.[4]
		expect(extras?.contextFiles).toBeUndefined()
	})

	it("does not load context files when includeContextFiles is absent", async () => {
		mockGetAgentConfig.mockReturnValue(makeAgentConfig())

		mockCreateAgentSession.mockResolvedValue({
			session: makeFakeSession() as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(mockLoadProjectContextFiles).not.toHaveBeenCalled()
		const extras = mockBuildAgentPrompt.mock.calls[0]?.[4]
		expect(extras?.contextFiles).toBeUndefined()
	})

	it("resolves guidelines from agent persona role, not orchestrator phase", async () => {
		mockGetAgentConfig.mockReturnValue(
			makeAgentConfig({ name: "Builder", description: "Build agent", roles: ["build"] }),
		)
		mockBuildPhaseGuidelinesSection.mockReturnValue("## Model Guidelines\n\nBuilder guideline")

		mockCreateAgentSession.mockResolvedValue({
			session: makeFakeSession() as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Builder", "do something", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(mockBuildPhaseGuidelinesSection).toHaveBeenCalledWith(undefined, "build", expect.anything())
		const extras = mockBuildAgentPrompt.mock.calls[0]?.[4]
		expect(extras?.guidelinesBlock).toContain("Builder guideline")
	})

	it("omits guidelines when agent has no persona role", async () => {
		mockGetAgentConfig.mockReturnValue(makeAgentConfig({ name: "General-Purpose" }))
		mockBuildPhaseGuidelinesSection.mockReturnValue("")

		mockCreateAgentSession.mockResolvedValue({
			session: makeFakeSession() as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(mockBuildPhaseGuidelinesSection).toHaveBeenCalledWith(undefined, undefined, expect.anything())
	})
})

// Regression test: PARENT_SESSION_ID_ENV_KEY must be set BEFORE the resource loader
// is created and extensions are bound. This ensures child agents inherit the parent
// session's permission mode correctly.
describe("runAgent — parent session ID env ordering", () => {
	let ctx: ReturnType<typeof makeFakeCtx>
	let pi: ReturnType<typeof makeFakePi>

	beforeEach(() => {
		ctx = makeFakeCtx()
		pi = makeFakePi()
		mockCreateAgentSession.mockReset()
		mockDefaultResourceLoader.mockClear()
		mockGetConfig.mockReturnValue(makeTypeConfig({ extensions: false, skills: false }))
		mockGetAgentConfig.mockReturnValue(makeAgentConfig())
		mockGetToolNamesForType.mockReturnValue([])
		// Clean up env
		delete process.env[PARENT_SESSION_ID_ENV_KEY]
	})

	afterEach(() => {
		vi.clearAllMocks()
		delete process.env[PARENT_SESSION_ID_ENV_KEY]
	})

	it("sets parent session ID env BEFORE resource loader is created", async () => {
		const envSnapshots: Array<{ phase: string; value: string | undefined }> = []

		// Capture env when DefaultResourceLoader is instantiated
		mockDefaultResourceLoader.mockImplementation(() => {
			envSnapshots.push({
				phase: "resource-loader-created",
				value: process.env[PARENT_SESSION_ID_ENV_KEY],
			})
			return {
				reload: vi.fn().mockResolvedValue(undefined),
			} as unknown as DefaultResourceLoader
		})

		const session = makeFakeSession({})
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
		})

		// Env should be set when resource loader is created
		const loaderSnapshot = envSnapshots.find((s) => s.phase === "resource-loader-created")
		expect(loaderSnapshot).toBeDefined()
		expect(loaderSnapshot?.value).toBe("session-1") // ctx.sessionManager.getSessionId() returns "session-1"
	})

	it("sets parent session ID env BEFORE session is created", async () => {
		const envSnapshots: Array<{ phase: string; value: string | undefined }> = []

		// Capture env when createAgentSession is called
		mockCreateAgentSession.mockImplementation(async () => {
			envSnapshots.push({
				phase: "session-created",
				value: process.env[PARENT_SESSION_ID_ENV_KEY],
			})
			return {
				session: makeFakeSession({}) as unknown as AgentSession,
				extensionsResult: { extensions: [], tools: [] },
			} as unknown as CreateAgentSessionResult
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
		})

		// Env should be set when session is created
		const sessionSnapshot = envSnapshots.find((s) => s.phase === "session-created")
		expect(sessionSnapshot).toBeDefined()
		expect(sessionSnapshot?.value).toBe("session-1")
	})

	it("makes parent session ID available during extension binding", async () => {
		const envDuringBind: (string | undefined)[] = []

		const session = makeFakeSession({})
		// Capture env when bindExtensions is called
		session.bindExtensions = vi.fn().mockImplementation(async () => {
			envDuringBind.push(process.env[PARENT_SESSION_ID_ENV_KEY])
		})

		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
		})

		// bindExtensions should have been called with the env var set
		expect(session.bindExtensions).toHaveBeenCalled()
		expect(envDuringBind).toEqual(["session-1"])
	})

	it("restores previous parent session ID after run completes", async () => {
		// Set an initial value
		process.env[PARENT_SESSION_ID_ENV_KEY] = "previous-session"

		const session = makeFakeSession({})
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
		})

		// Original value should be restored
		expect(process.env[PARENT_SESSION_ID_ENV_KEY]).toBe("previous-session")
	})

	it("restores previous parent session ID even when run throws", async () => {
		// Set an initial value
		process.env[PARENT_SESSION_ID_ENV_KEY] = "previous-session"

		// Make session creation fail
		mockCreateAgentSession.mockRejectedValue(new Error("session creation failed"))

		await expect(
			runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
				pi: pi as unknown as RunOptions["pi"],
			}),
		).rejects.toThrow("session creation failed")

		// Original value should still be restored
		expect(process.env[PARENT_SESSION_ID_ENV_KEY]).toBe("previous-session")
	})

	it("clears parent session ID after run if it was not previously set", async () => {
		// Ensure no initial value
		delete process.env[PARENT_SESSION_ID_ENV_KEY]

		const session = makeFakeSession({})
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "General-Purpose", "do something", {
			pi: pi as unknown as RunOptions["pi"],
		})

		// Should be cleaned up (deleted, not just undefined)
		expect(process.env[PARENT_SESSION_ID_ENV_KEY]).toBeUndefined()
		expect(Object.prototype.hasOwnProperty.call(process.env, PARENT_SESSION_ID_ENV_KEY)).toBe(false)
	})
})

describe("steerAgent — explicit steering", () => {
	it("does NOT add orchestrator prefix to explicit steer messages", async () => {
		const { steerAgent } = await import("./agent-runner.js")
		const session = makeFakeSession()
		await steerAgent(session as unknown as AgentSession, "custom user steer")
		expect(session.steer).toHaveBeenCalledWith("custom user steer")
		expect(session.steer).not.toHaveBeenCalledWith(expect.stringContaining("[Orchestrator"))
	})
})

describe("resumeAgent — inactivity steering", () => {
	it("adds orchestrator prefix to automated inactivity steer", async () => {
		const { resumeAgent } = await import("./agent-runner.js")
		vi.useFakeTimers()

		const subscribers: Subscriber[] = []
		const session = {
			subscribe: vi.fn((cb: Subscriber) => {
				subscribers.push(cb)
				return () => {
					const idx = subscribers.indexOf(cb)
					if (idx !== -1) subscribers.splice(idx, 1)
				}
			}),
			abort: vi.fn(),
			steer: vi.fn(),
			messages: [],
			prompt: vi.fn().mockImplementation(async () => {
				// Advance time past inactivity timeout during prompt
				await vi.advanceTimersByTimeAsync(130_000)
			}),
			extensionRunner: { emit: vi.fn().mockResolvedValue(true) },
		}

		const promise = resumeAgent(session as unknown as AgentSession, "resume prompt", {
			inactivityTimeout: 120_000,
		})

		await promise

		expect(session.steer).toHaveBeenCalledWith(
			expect.stringMatching(/\[Orchestrator — automated system instruction, not a user message\]/),
		)
		expect(session.steer).toHaveBeenCalledWith(expect.stringContaining("You appear to be stalled"))

		vi.useRealTimers()
	})
})
