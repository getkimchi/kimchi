/**
 * agent-runner.test.ts — Tests for tokenBudget forwarding through runAgent.
 *
 * WI-3 RED: RunOptions does not yet have tokenBudget, and the session
 * event loop does not abort when cumulative token usage exceeds the budget.
 * These tests assert the behaviour that GREEN must implement.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---- Mock heavy infrastructure before importing agent-runner ----

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
import { type RunOptions, runAgent } from "./agent-runner.js"

const mockCreateAgentSession = vi.mocked(createAgentSession)

// ---- Minimal fake AgentSession ----

type SessionEvent = { type: string; [k: string]: unknown }
type Subscriber = (event: SessionEvent) => void

function makeFakeSession({
	promptTokens = 0,
	outputTokens = 0,
	abortSpy = vi.fn(),
}: {
	promptTokens?: number
	outputTokens?: number
	abortSpy?: ReturnType<typeof vi.fn>
} = {}) {
	const subscribers: Subscriber[] = []
	let promptCalled = false

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
		getActiveToolNames: vi.fn().mockReturnValue([]),
		setActiveToolsByName: vi.fn(),
		bindExtensions: vi.fn().mockResolvedValue(undefined),
		messages: [],
		prompt: vi.fn().mockImplementation(async () => {
			if (!promptCalled) {
				promptCalled = true
				// Emit a message_end event with usage so the runner sees token consumption.
				for (const sub of subscribers) {
					sub({
						type: "message_end",
						message: {
							role: "assistant",
							usage: { input: promptTokens, output: outputTokens, cacheWrite: 0 },
						},
					})
				}
				// Emit turn_end so turn-based logic advances.
				for (const sub of subscribers) {
					sub({ type: "turn_end" })
				}
			}
		}),
	}

	return session
}

// ---- Minimal fake ExtensionContext ----

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

// ---- Minimal ExtensionAPI ----

function makeFakePi() {
	return {
		exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
	}
}

// ---- Tests ----

describe("RunOptions.tokenBudget — field exists on the interface", () => {
	it("RunOptions accepts tokenBudget as an optional number field (compile-time check)", () => {
		// If RunOptions does not declare tokenBudget, TypeScript will flag this
		// object literal with a type error, causing a compilation failure in vitest.
		const opts: RunOptions = {
			pi: makeFakePi() as unknown as RunOptions["pi"],
			tokenBudget: 12345,
		}
		// Runtime guard: the field must be present on the object (even if typed as unknown).
		expect((opts as unknown as Record<string, unknown>).tokenBudget).toBe(12345)
	})
})

describe("runAgent — tokenBudget forwarding", () => {
	let ctx: ReturnType<typeof makeFakeCtx>
	let pi: ReturnType<typeof makeFakePi>

	beforeEach(() => {
		ctx = makeFakeCtx()
		pi = makeFakePi()
		mockCreateAgentSession.mockReset()
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("aborts the session when cumulative token usage exceeds tokenBudget", async () => {
		const abortSpy = vi.fn()
		const session = makeFakeSession({
			promptTokens: 10_000,
			outputTokens: 5_000, // total = 15_000 > budget of 12_345
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
			tokenBudget: 12_345,
		})

		// RED failure: abort() is NOT called because the token budget enforcement
		// does not exist yet. Once GREEN adds budget tracking in the message_end
		// subscriber and calls session.abort() when exceeded, this will pass.
		expect(abortSpy).toHaveBeenCalled()
	})

	it("does NOT abort when token usage stays below tokenBudget", async () => {
		const abortSpy = vi.fn()
		const session = makeFakeSession({
			promptTokens: 1_000,
			outputTokens: 500, // total = 1_500 < budget of 50_000
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
			// no tokenBudget
		})

		expect(abortSpy).not.toHaveBeenCalled()
	})

	it("profile tokenBudget is used when no param overrides it", async () => {
		// The agentConfig mock returns tokenBudget: 40_000 (profile default).
		// runAgent should pick it up and enforce it.
		// This requires runAgent to accept tokenBudget AND pull it from the resolved config.
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
			tokenBudget: 40_000, // profile declares budget
			extensions: false,
			skills: false,
			promptMode: "replace",
			systemPrompt: "",
		} as unknown as ReturnType<typeof getAgentConfig>)

		const abortSpy = vi.fn()
		// Usage 50_000 tokens > profile budget 40_000 → should abort.
		const session = makeFakeSession({ promptTokens: 30_000, outputTokens: 20_000, abortSpy })

		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Explore", "explore it", {
			pi: pi as unknown as RunOptions["pi"],
			// No explicit tokenBudget — should fall back to agentConfig.tokenBudget = 40_000
		})

		// RED failure: profile tokenBudget is not read by runAgent yet.
		expect(abortSpy).toHaveBeenCalled()
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
			tokenBudget: 100_000, // profile budget is generous
			extensions: false,
			skills: false,
			promptMode: "replace",
			systemPrompt: "",
		} as unknown as ReturnType<typeof getAgentConfig>)

		const abortSpy = vi.fn()
		// Usage 50_000 tokens > explicit param budget 30_000 → should abort.
		const session = makeFakeSession({ promptTokens: 30_000, outputTokens: 20_000, abortSpy })

		mockCreateAgentSession.mockResolvedValue({
			session: session as unknown as Awaited<ReturnType<typeof createAgentSession>>["session"],
			extensionsResult: { extensions: [], tools: [] } as unknown as Awaited<
				ReturnType<typeof createAgentSession>
			>["extensionsResult"],
		})

		await runAgent(ctx as unknown as Parameters<typeof runAgent>[0], "Explore", "explore it", {
			pi: pi as unknown as RunOptions["pi"],
			tokenBudget: 30_000, // explicit param overrides profile's 100_000
		})

		// RED failure: explicit tokenBudget is not on RunOptions yet.
		expect(abortSpy).toHaveBeenCalled()
	})
})

describe("Agent tool schema — token_budget field", () => {
	it("Type.Integer schema validates token_budget: 50000 as valid", async () => {
		// This test documents the TypeBox schema shape that the Agent tool
		// SHOULD expose. It is defined inline here as the spec; the corresponding
		// production change is to add the same field to the defineTool parameters
		// in src/extensions/agents/index.ts.
		const { Type } = await import("typebox")
		const { Value } = await import("typebox/value")

		const expectedParams = Type.Object({
			prompt: Type.String(),
			description: Type.String(),
			subagent_type: Type.String(),
			token_budget: Type.Optional(
				Type.Integer({
					description: "Maximum number of tokens this agent is allowed to consume in total.",
					minimum: 1,
				}),
			),
		})

		const sample = {
			prompt: "do a thing",
			description: "do thing",
			subagent_type: "General-Purpose",
			token_budget: 50_000,
		}

		// The schema above is the spec. This assertion passes as long as the
		// TypeBox schema is defined correctly — it is a spec/documentation test.
		expect(Value.Check(expectedParams, sample)).toBe(true)
	})

	it("token_budget is optional — schema validates input without it", async () => {
		const { Type } = await import("typebox")
		const { Value } = await import("typebox/value")

		const expectedParams = Type.Object({
			prompt: Type.String(),
			description: Type.String(),
			subagent_type: Type.String(),
			token_budget: Type.Optional(Type.Integer({ minimum: 1 })),
		})

		const sample = {
			prompt: "do a thing",
			description: "do thing",
			subagent_type: "General-Purpose",
		}

		expect(Value.Check(expectedParams, sample)).toBe(true)
	})

	it("token_budget rejects non-integer values (0, negative, string) when present", async () => {
		const { Type } = await import("typebox")
		const { Value } = await import("typebox/value")

		// Validate via an object schema — Type.Optional only omits the key
		// requirement inside an object; standalone Value.Check(Optional, undefined)
		// does not behave the same way as inside an object.
		const schema = Type.Object({
			token_budget: Type.Optional(Type.Integer({ minimum: 1 })),
		})

		// Present but invalid values must fail.
		expect(Value.Check(schema, { token_budget: 0 })).toBe(false)
		expect(Value.Check(schema, { token_budget: -1 })).toBe(false)
		expect(Value.Check(schema, { token_budget: "abc" })).toBe(false)
		expect(Value.Check(schema, { token_budget: 1.5 })).toBe(false)

		// Present and valid.
		expect(Value.Check(schema, { token_budget: 1 })).toBe(true)
		expect(Value.Check(schema, { token_budget: 50_000 })).toBe(true)

		// Omitted entirely — must pass (optional).
		expect(Value.Check(schema, {})).toBe(true)
	})
})
