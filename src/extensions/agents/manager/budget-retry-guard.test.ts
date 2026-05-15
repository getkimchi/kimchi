import { describe, expect, it } from "vitest"
import { createBudgetRetryBlock, shouldBlockBudgetRetry } from "./budget-retry-guard.js"

describe("budget retry guard", () => {
	it("blocks a higher-budget retry of the same failed call", () => {
		const block = createBudgetRetryBlock({
			budget: 100,
			subagentType: "Explore",
			description: "Explore agent extension",
			prompt: "inspect repository",
		})

		expect(
			shouldBlockBudgetRetry(block, {
				tokenBudget: 1_000,
				subagentType: "Explore",
				description: "Explore agent extension",
				prompt: "inspect repository",
			}),
		).toBe(true)
	})

	it("allows a different agent type requested in the same user turn", () => {
		const block = createBudgetRetryBlock({
			budget: 100,
			subagentType: "Explore",
			description: "Explore agent extension",
			prompt: "inspect repository",
		})

		expect(
			shouldBlockBudgetRetry(block, {
				tokenBudget: 1_000,
				subagentType: "Plan",
				description: "Plan agent extension",
				prompt: "inspect repository",
			}),
		).toBe(false)
	})

	it("allows a different task for the same agent type", () => {
		const block = createBudgetRetryBlock({
			budget: 100,
			subagentType: "Explore",
			description: "Explore agent extension",
			prompt: "inspect repository",
		})

		expect(
			shouldBlockBudgetRetry(block, {
				tokenBudget: 1_000,
				subagentType: "Explore",
				description: "Explore package metadata",
				prompt: "inspect package metadata",
			}),
		).toBe(false)
	})
})
