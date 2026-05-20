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
			create: vi.fn().mockReturnValue({}),
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
		strengths: undefined,
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

import { createAgentSession } from "@earendil-works/pi-coding-agent"
import { getAgentConfig, getConfig, getToolNamesForType } from "../personas/agent-types.js"
import { type RunOptions, runAgent } from "./agent-runner.js"

const mockCreateAgentSession = vi.mocked(createAgentSession)
const mockGetConfig = vi.mocked(getConfig)
const mockGetAgentConfig = vi.mocked(getAgentConfig)
const mockGetToolNamesForType = vi.mocked(getToolNamesForType)

type SessionEvent = { type: string; [k: string]: unknown }
type Subscriber = (event: SessionEvent) => void

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
} = {}) {
	const subscribers: Subscriber[] = []
	let promptCalled = false
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

	return session
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
		strengths: undefined,
		models: undefined,
		...overrides,
	}
}

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
			strengths: ["explore"],
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
			strengths: ["explore"],
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
				strengths: ["research"],
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
			"steers at 50% of turn budget": {
				maxTurns: 10,
				turns: 5,
				expectedSteerCount: 1,
				pattern: /Budget check.*Turn 5\/10/,
			},
			"steers at 75% of turn budget": {
				maxTurns: 10,
				turns: 8,
				expectedSteerCount: 2,
				pattern: /Budget check.*Turn 8\/10/,
			},
			"does not steer before 50% of turn budget": {
				maxTurns: 10,
				turns: 4,
				expectedSteerCount: 0,
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
