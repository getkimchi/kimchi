import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveAgentInvocationConfig } from "./invocation-config.js"
import { AGENT_WORKER_BUDGETS } from "../worker-budget-policy.js"

const agent = {
	name: "test",
	description: "t",
	extensions: true as const,
	skills: true as const,
	systemPrompt: "",
	promptMode: "replace" as const,
}

describe("resolveAgentInvocationConfig — model selection", () => {
	afterEach(() => {
		vi.clearAllMocks()
	})

	it("uses params.model when provided", () => {
		const result = resolveAgentInvocationConfig(agent, { model: "kimchi-dev/minimax-m2.7" })
		expect(result.modelInput).toBe("kimchi-dev/minimax-m2.7")
		expect(result.modelFromParams).toBe(true)
	})

	it("modelInput is undefined when params.model is omitted", () => {
		const result = resolveAgentInvocationConfig(agent, {})
		expect(result.modelInput).toBeUndefined()
		expect(result.modelFromParams).toBe(false)
	})

	it("modelInput is undefined when params.model is empty string", () => {
		const result = resolveAgentInvocationConfig(agent, { model: "" })
		expect(result.modelInput).toBeUndefined()
		expect(result.modelFromParams).toBe(false)
	})
})

describe("resolveAgentInvocationConfig — tokenBudget precedence", () => {
	afterEach(() => {
		vi.clearAllMocks()
	})

	it("agentConfig.tokenBudget used when params has no token_budget", () => {
		const result = resolveAgentInvocationConfig({ ...agent, tokenBudget: 80_000 }, {})
		expect(result.tokenBudget).toBe(80_000)
	})

	it("params.token_budget wins over agentConfig.tokenBudget", () => {
		const result = resolveAgentInvocationConfig(
			{ ...agent, tokenBudget: 80_000 },
			{
				token_budget: 50_000,
			} as Parameters<typeof resolveAgentInvocationConfig>[1] & { token_budget?: number },
		)
		expect(result.tokenBudget).toBe(50_000)
	})

	it("accepts tokenBudget as a compatibility alias", () => {
		const result = resolveAgentInvocationConfig(
			{ ...agent, tokenBudget: 80_000 },
			{
				tokenBudget: 50_000,
			} as Parameters<typeof resolveAgentInvocationConfig>[1] & { tokenBudget?: number },
		)
		expect(result.tokenBudget).toBe(50_000)
	})

	it("tokenBudget is undefined when neither agentConfig nor params supply a value", () => {
		const result = resolveAgentInvocationConfig(agent, {})
		expect(result.tokenBudget).toBeUndefined()
	})
})

describe("resolveAgentInvocationConfig — persona policy precedence", () => {
	afterEach(() => {
		vi.clearAllMocks()
	})

	it("agentConfig.thinking used when params has no thinking", () => {
		const result = resolveAgentInvocationConfig(
			{ ...agent, thinking: "medium" as const },
			{},
		)
		expect(result.thinking).toBe("medium")
	})

	it("params.thinking wins over agentConfig.thinking", () => {
		const result = resolveAgentInvocationConfig(
			{ ...agent, thinking: "medium" as const },
			{ thinking: "high" },
		)
		expect(result.thinking).toBe("high")
	})
})

describe("resolveAgentInvocationConfig — default max_turns", () => {
	it("uses AGENT_WORKER_BUDGETS.default.maxTurns when neither caller nor persona specify max_turns", () => {
		const result = resolveAgentInvocationConfig(undefined, {})
		expect(result.maxTurns).toBe(AGENT_WORKER_BUDGETS.default.maxTurns)
	})

	it("uses caller-provided max_turns over the default", () => {
		const result = resolveAgentInvocationConfig(undefined, { max_turns: 50 })
		expect(result.maxTurns).toBe(50)
	})

	it("uses persona-provided maxTurns over the default", () => {
		const result = resolveAgentInvocationConfig(
			{ maxTurns: 20 } as Parameters<typeof resolveAgentInvocationConfig>[0],
			{},
		)
		expect(result.maxTurns).toBe(20)
	})

	it("persona maxTurns takes precedence over caller max_turns", () => {
		const result = resolveAgentInvocationConfig(
			{ maxTurns: 20 } as Parameters<typeof resolveAgentInvocationConfig>[0],
			{ max_turns: 50 },
		)
		expect(result.maxTurns).toBe(20)
	})
})
