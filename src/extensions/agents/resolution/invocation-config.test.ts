import { describe, expect, it } from "vitest"
import { resolveAgentInvocationConfig } from "./invocation-config.js"
import { AGENT_WORKER_BUDGETS } from "../worker-budget-policy.js"

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
