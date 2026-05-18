import { describe, expect, it } from "vitest"
import {
	createBudgetRetryBlock,
	createBudgetRetryBlockFromCompletion,
	shouldBlockBudgetRetry,
} from "./budget-retry-guard.js"

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

	it("creates a retry block when a background completion reports token budget abort", () => {
		const block = createBudgetRetryBlockFromCompletion(
			{
				budget: 100,
				subagentType: "Explore",
				description: "Explore agent extension",
				prompt: "inspect repository",
			},
			{ status: "aborted", abortReason: "token_budget" },
		)

		expect(block).toMatchObject({
			budget: 100,
			subagentType: "Explore",
			normalizedDescription: "explore agent extension",
			normalizedPrompt: "inspect repository",
		})
	})

	it("does not create a retry block for non-budget completions", () => {
		const candidate = {
			budget: 100,
			subagentType: "Explore",
			description: "Explore agent extension",
			prompt: "inspect repository",
		}

		expect(createBudgetRetryBlockFromCompletion(candidate, { status: "completed" })).toBeUndefined()
		expect(
			createBudgetRetryBlockFromCompletion(candidate, { status: "aborted", abortReason: "max_turns" }),
		).toBeUndefined()
	})
})
