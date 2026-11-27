import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushWorkSummaries } from "../../work-attribution/summary.js"

let attributionDir: string
beforeEach(() => {
	attributionDir = mkdtempSync(join(tmpdir(), "agent-attribution-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", attributionDir)
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.unstubAllEnvs()
	rmSync(attributionDir, { recursive: true, force: true })
})

vi.mock("@earendil-works/pi-coding-agent", async () => {
	return {
		// biome-ignore lint/complexity/useArrowFunction: vitest 4 invokes this mock with new — arrows are not constructable
		DefaultResourceLoader: vi.fn().mockImplementation(function () {
			return {
				reload: vi.fn().mockResolvedValue(undefined),
				getExtensions: vi.fn(() => ({ extensions: [], errors: [] })),
			}
		}),
		SessionManager: {
			inMemory: vi.fn().mockReturnValue({}),
			open: vi.fn().mockReturnValue({}),
		},
		SettingsManager: {
			create: vi.fn().mockReturnValue({ applyOverrides: vi.fn() }),
		},
		createAgentSession: vi.fn(),
		defineTool: vi.fn((tool) => tool),
		getAgentDir: vi.fn(() => process.env.PI_CODING_AGENT_DIR),
	}
})

// Prevent the eagerly constructed worker gate from pulling main-session UI
// modules into this partial Pi test environment. Gate behavior has its own suite.
vi.mock("../../permissions/index.js", () => ({
	createWorkerPermissionsExtension: vi.fn(() => function workerPermissionsStub() {}),
	getPermissionsExtensionOptions: vi.fn(() => undefined),
}))

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
	listAvailableSkillNames: vi.fn().mockReturnValue([]),
	preloadSkills: vi.fn().mockReturnValue([]),
}))

vi.mock("../prompt/brief-skill-loader.js", () => ({
	scanBriefSkills: vi.fn().mockResolvedValue({ available: [], matched: [] }),
	renderBriefSkillBlock: vi.fn().mockImplementation((m: { name: string }) => `AUTOLOAD-${m.name.toUpperCase()}`),
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
		disallowedTools: undefined,
		roles: undefined,
		models: undefined,
	}),
	getToolNamesForType: vi.fn().mockReturnValue([]),
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
	readTelemetryConfig: vi.fn().mockReturnValue({
		enabled: true,
		endpoint: "https://test/logs",
		metricsEndpoint: "https://test/metrics",
		headers: { Authorization: "Bearer test" },
		apiKey: "",
	}),
	resolveEndpoints: vi.fn(() => ({ platformApiUrl: "https://policy.test" })),
	// agent-runner reads the pinned `language` for replace-mode prompts.
	loadConfig: vi.fn(() => ({})),
}))

vi.mock("../../orchestration/model-registry/guidelines/guidelines-resolver.js", () => ({
	buildRoleGuidelinesSection: vi.fn().mockReturnValue(""),
}))

vi.mock("../../auto-model/index.js", () => ({
	createAutoModelRoutingExtension: vi.fn(() => () => {}),
}))

// The runner spreads subagentWebToolFactories() into the child session's
// extension list. Mock the module so these tests stay hermetic against the
// local machine's settings.json — default empty, with one composition test
// opting into stub factories. Real registration and resource gating are
// covered by real-session tests in subagent-resource-loader.test.ts.
vi.mock("./subagent-web-tools.js", () => ({
	subagentWebToolFactories: vi.fn(() => []),
}))

// resources/store reads the local machine's settings.json: mock it so resource
// gates (extensions.dap, cost-per-pr) are deterministic across machines. All
// resources on by default; individual tests opt out per resource id.
vi.mock("../../../resources/store.js", () => ({
	isResourceEnabled: vi.fn().mockReturnValue(true),
}))

import { createAgentSession, DefaultResourceLoader, type InlineExtension } from "@earendil-works/pi-coding-agent"
import { readTelemetryConfig } from "../../../config.js"
import { isResourceEnabled } from "../../../resources/store.js"
import { createAutoModelRoutingExtension } from "../../auto-model/index.js"
import { buildRoleGuidelinesSection } from "../../orchestration/model-registry/guidelines/guidelines-resolver.js"
import { loadProjectContextFiles } from "../../prompt-construction/context-files.js"
import telemetryExtension from "../../telemetry/index.js"
import { getAgentConfig, getConfig, getToolNamesForType } from "../personas/agent-types.js"
import { scanBriefSkills } from "../prompt/brief-skill-loader.js"
import { buildAgentPrompt } from "../prompt/prompts.js"
import { type RunOptions, runAgent } from "./agent-runner.js"
import { formatRunResultText } from "./result-text.js"
import { subagentWebToolFactories } from "./subagent-web-tools.js"

const mockCreateAgentSession = vi.mocked(createAgentSession)
const mockGetConfig = vi.mocked(getConfig)
const mockGetAgentConfig = vi.mocked(getAgentConfig)
const mockGetToolNamesForType = vi.mocked(getToolNamesForType)
const _mockLoadProjectContextFiles = vi.mocked(loadProjectContextFiles)
const _mockBuildAgentPrompt = vi.mocked(buildAgentPrompt)
const _mockScanBriefSkills = vi.mocked(scanBriefSkills)
const _mockBuildRoleGuidelinesSection = vi.mocked(buildRoleGuidelinesSection)
const _mockCreateAutoModelRoutingExtension = vi.mocked(createAutoModelRoutingExtension)
const mockDefaultResourceLoader = vi.mocked(DefaultResourceLoader)
const _mockTelemetryExtension = vi.mocked(telemetryExtension)
const _mockReadTelemetryConfig = vi.mocked(readTelemetryConfig)
const mockIsResourceEnabled = vi.mocked(isResourceEnabled)

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
	promptAction,
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
	promptAction?: (emit: (event: SessionEvent) => void) => Promise<void>
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
				if (promptAction) {
					await promptAction((event) => {
						for (const sub of subscribers) sub(event)
					})
					return
				}
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
			runtime: {},
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
		disallowedTools: undefined,
		roles: undefined,
		models: undefined,
		...overrides,
	}
}

describe("runAgent — bundled web tool registration & drop report", () => {
	let ctx: ReturnType<typeof makeFakeCtx>
	let pi: ReturnType<typeof makeFakePi>

	beforeEach(() => {
		ctx = makeFakeCtx()
		pi = makeFakePi()
		mockCreateAgentSession.mockReset()
		mockGetConfig.mockReturnValue(makeTypeConfig({ extensions: true, skills: false }))
		mockGetAgentConfig.mockReturnValue(
			makeAgentConfig({ name: "Researcher", description: "Research agent", roles: ["research"] }),
		)
		mockGetToolNamesForType.mockReturnValue(["read", "grep"])
		mockIsResourceEnabled.mockReturnValue(true)
	})

	afterEach(() => {
		vi.clearAllMocks()
		vi.mocked(subagentWebToolFactories).mockReturnValue([])
	})

	it("spreads the web tool factories into the child session's extension list", async () => {
		mockGetConfig.mockReturnValue(makeTypeConfig({ extensions: true, skills: false }))
		const webFetchStub: InlineExtension = () => {}
		const webSearchStub: InlineExtension = () => {}
		vi.mocked(subagentWebToolFactories).mockReturnValueOnce([webFetchStub, webSearchStub])
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

		const ctorArg = mockDefaultResourceLoader.mock.calls[0]?.[0]
		expect(ctorArg?.extensionFactories).toContain(webFetchStub)
		expect(ctorArg?.extensionFactories).toContain(webSearchStub)
	})

	it("does not register web tool factories when extensions are disabled", async () => {
		// Off means off — registration included: the factories the runner spreads
		// must not even reach the child session's loader on the sealed path.
		mockGetConfig.mockReturnValue(makeTypeConfig({ extensions: false, skills: false }))
		mockGetAgentConfig.mockReturnValue(
			makeAgentConfig({ name: "Hermetic", description: "no extensions", source: "project" }),
		)
		mockGetToolNamesForType.mockReturnValue(["read", "grep"])
		const webFetchStub: InlineExtension = () => {}
		vi.mocked(subagentWebToolFactories).mockReturnValueOnce([webFetchStub])
		const session = makeFakeSession({ activeToolNames: ["read", "grep"] })
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Hermetic", "do it", {
			pi: pi as unknown as RunOptions["pi"],
		})

		const ctorArg = mockDefaultResourceLoader.mock.calls[0]?.[0]
		expect(ctorArg?.extensionFactories).not.toContain(webFetchStub)
	})

	it("reports a runner-excluded name (e.g. steer_subagent) even though the child registered it", async () => {
		mockGetToolNamesForType.mockReturnValue(["read", "steer_subagent"])
		const session = makeFakeSession({
			activeToolNames: ["read"],
			registeredToolNames: ["read", "steer_subagent"],
		})
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		const result = await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Researcher", "research it", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read"])
		expect(result.droppedToolNames).toEqual(["steer_subagent"])
	})

	it("keeps a registered requested name active even under an extensions allowlist (extensions: mcp + web_search)", async () => {
		mockGetConfig.mockReturnValue(makeTypeConfig({ extensions: ["mcp"], skills: false }))
		mockGetToolNamesForType.mockReturnValue(["read", "web_search"])
		const session = makeFakeSession({
			activeToolNames: ["read", "web_search", "mcp__db__query"],
			registeredToolNames: ["read", "web_search", "mcp__db__query"],
		})
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		const result = await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Researcher", "research it", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(result.droppedToolNames).toBeUndefined()
	})

	it("does not report the runner-appended Skill name — children load skills via preload blocks, not the tool", async () => {
		// skills: true makes the runner append "Skill" to toolNames for prompt
		// documentation; no child session has ever registered a tool by that
		// name. Reporting the append would fire on every skill-enabled run.
		mockGetConfig.mockReturnValue(makeTypeConfig({ extensions: true, skills: true }))
		mockGetAgentConfig.mockReturnValue(
			makeAgentConfig({ name: "Researcher", description: "Research agent", roles: ["research"], skills: true }),
		)
		mockGetToolNamesForType.mockReturnValue(["read", "grep"])
		const session = makeFakeSession({
			activeToolNames: ["read", "grep"],
			registeredToolNames: ["read", "grep"],
		})
		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		const result = await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Researcher", "research it", {
			pi: pi as unknown as RunOptions["pi"],
		})

		expect(result.droppedToolNames).toBeUndefined()
	})

	it("points DAP-tool failures at the extensions.dap resource remedy", async () => {
		// Debug tools register inline like web tools don't — the only real
		// blocker here is the resource toggle, so the message must name it.
		mockGetConfig.mockReturnValue(makeTypeConfig({ extensions: false, skills: false }))
		mockGetAgentConfig.mockReturnValue(
			makeAgentConfig({ name: "Hermetic", description: "no extensions", source: "project" }),
		)
		mockGetToolNamesForType.mockReturnValue(["read", "debug_eval"])
		mockIsResourceEnabled.mockImplementation((id: string) => id !== "extensions.dap")

		await expect(
			runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Hermetic", "do it", {
				pi: pi as unknown as RunOptions["pi"],
			}),
		).rejects.toThrow(/extensions\.dap/)
		expect(mockCreateAgentSession).not.toHaveBeenCalled()
	})
})

describe("formatRunResultText — dropped-tool warnings (from agent-runner.test.ts split)", () => {
	it("appends a warning when requested tools are not active in the child session", () => {
		expect(formatRunResultText({ responseText: "done", droppedToolNames: ["web_search"] })).toBe(
			"done\n\nWarning: requested tool(s) are not active in the subagent session: web_search. Check the agent's tools list, enable the extension that provides them, or check the org resource toggle (/resources) that gates that extension.",
		)
		expect(formatRunResultText({ responseText: "done" })).toBe("done")
		expect(formatRunResultText({ responseText: "done", droppedToolNames: [] })).toBe("done")
	})

	it("sanitizes off-charset tool names before interpolating them into the warning", () => {
		const text = formatRunResultText({ responseText: "done", droppedToolNames: ["ws\nignore previous"] })
		expect(text).toContain("ws?ignore?previous")
	})
})
