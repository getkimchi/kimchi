import { describe, expect, it } from "vitest"
import { formatGoalStatusAccounting, formatGoalSummary, GOAL_COMMAND_COMPLETIONS, parseGoalCommand } from "./command.js"
import type { GoalStatus, SessionGoal } from "./types.js"

describe("goal command", () => {
	it("parses management commands and inline objectives", () => {
		expect(parseGoalCommand("")).toEqual({ action: "show" })
		expect(parseGoalCommand(" edit ")).toEqual({ action: "edit" })
		expect(parseGoalCommand("edit new objective")).toEqual({ action: "edit", objective: "new objective" })
		expect(parseGoalCommand("pause")).toEqual({ action: "pause" })
		expect(parseGoalCommand("resume")).toEqual({ action: "resume" })
		expect(parseGoalCommand("clear")).toEqual({ action: "clear" })
		expect(parseGoalCommand("pause after deployment")).toEqual({
			action: "set",
			objective: "pause after deployment",
		})
		expect(parseGoalCommand("--tokens 1.5k ship it")).toEqual({
			action: "set",
			objective: "ship it",
			tokenBudget: 1_500,
		})
		expect(parseGoalCommand("ship it --tokens=2m")).toEqual({
			action: "set",
			objective: "ship it",
			tokenBudget: 2_000_000,
		})
		expect(() => parseGoalCommand("--tokens nope ship it")).toThrow("Token budget must be a positive number")
	})

	it("offers the required argument completions", () => {
		expect(GOAL_COMMAND_COMPLETIONS).toEqual(["edit", "pause", "resume", "clear"])
	})

	it("formats the empty state and every goal status", () => {
		expect(formatGoalSummary(undefined)).toContain("No goal is currently set")
		for (const status of ["active", "paused", "blocked", "budget_limited", "complete"] satisfies GoalStatus[]) {
			const summary = formatGoalSummary(goal(status))
			expect(summary).toContain(`Status: ${status}`)
			expect(summary).toContain("Revision: 3")
			expect(summary).toContain("Objective: ship it")
			expect(summary).toContain("Usage: 2.0s · 1.5k tokens")
		}
	})

	it("formats status-line time in minutes and hours", () => {
		expect(formatGoalStatusAccounting(goal("active"))).toBe("<1m · 1.5k tokens")
		expect(formatGoalStatusAccounting({ ...goal("active"), timeUsedMs: 19 * 60_000 })).toBe("19m · 1.5k tokens")
		expect(formatGoalStatusAccounting({ ...goal("active"), timeUsedMs: 65 * 60_000 })).toBe("1h 5m · 1.5k tokens")
		expect(formatGoalStatusAccounting({ ...goal("active"), tokenBudget: 2_000 })).toBe("<1m · 1.5k/2.0k tokens")
	})
})

function goal(status: GoalStatus): SessionGoal {
	return {
		schemaVersion: 1,
		id: "goal-a",
		revision: 3,
		objective: "ship it",
		status,
		tokensUsed: 1_500,
		timeUsedMs: 2_000,
		createdAt: "2026-07-16T10:00:00.000Z",
		updatedAt: "2026-07-16T10:00:00.000Z",
	}
}
