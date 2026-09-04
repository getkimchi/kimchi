import { describe, expect, it } from "vitest"
import {
	FERMENT_V2_COMMAND_COMPLETIONS,
	formatFermentV2Accounting,
	formatFermentV2Duration,
	formatFermentV2Summary,
	parseFermentV2Command,
} from "./command.js"
import type { FermentV2Status, SessionFermentV2 } from "./types.js"

describe("Ferment V2 command", () => {
	it("parses management commands and inline objectives", () => {
		expect(parseFermentV2Command("")).toEqual({ action: "show" })
		expect(parseFermentV2Command(" edit ")).toEqual({ action: "edit" })
		expect(parseFermentV2Command("edit new objective")).toEqual({ action: "edit", objective: "new objective" })
		expect(parseFermentV2Command("pause")).toEqual({ action: "pause" })
		expect(parseFermentV2Command("resume")).toEqual({ action: "resume" })
		expect(parseFermentV2Command("pause after deployment")).toEqual({
			action: "set",
			objective: "pause after deployment",
		})
		expect(parseFermentV2Command("--tokens 1.5k ship it")).toEqual({
			action: "set",
			objective: "ship it",
			tokenBudget: 1_500,
		})
		expect(parseFermentV2Command("ship it --tokens=2m")).toEqual({
			action: "set",
			objective: "ship it",
			tokenBudget: 2_000_000,
		})
		expect(() => parseFermentV2Command("--tokens nope ship it")).toThrow("Token budget must be a positive number")
	})

	it("clears only with the canonical spelling", () => {
		expect(parseFermentV2Command("clear")).toEqual({ action: "clear" })
		expect(parseFermentV2Command("CLEAR")).toEqual({ action: "clear" })
		for (const objective of ["stop", "off", "reset", "none", "cancel"]) {
			expect(parseFermentV2Command(objective)).toEqual({ action: "set", objective })
		}
	})

	it("offers the required argument completions", () => {
		expect(FERMENT_V2_COMMAND_COMPLETIONS).toEqual(["edit", "pause", "resume", "clear"])
	})

	it("formats the empty state and every Ferment V2 status", () => {
		expect(formatFermentV2Summary(undefined)).toContain("No Ferment V2 is currently set")
		for (const status of ["active", "paused", "blocked", "budget_limited", "complete"] satisfies FermentV2Status[]) {
			const summary = formatFermentV2Summary(fermentV2(status))
			expect(summary).toContain(`Status: ${status}`)
			expect(summary).toContain("Revision: 3")
			expect(summary).toContain("Objective: ship it")
			expect(summary).toContain("Fermenting time: <1m · 1.5k tokens")
		}
	})

	it("uses a neutral summary for an automatic approved plan while preserving manual branding", () => {
		const manual = formatFermentV2Summary(fermentV2("active"))
		const automatic = formatFermentV2Summary({
			...fermentV2("active"),
			presentation: { kind: "approved-plan", title: "Cache Layer", planPath: "/tmp/cache-layer.md" },
		})

		expect(manual.startsWith("Ferment V2\n")).toBe(true)
		expect(automatic).toContain("Plan: Cache Layer")
		expect(automatic).not.toMatch(/ferment[- ]v2/i)
	})

	it("shows evaluation details only in the full command summary", () => {
		const evaluated = {
			...fermentV2("active"),
			evaluationCount: 2,
			lastEvaluation: {
				verdict: "continue" as const,
				reason: "missing smoke test",
				model: "test/judge",
				evaluatedAt: "2026-07-16T10:02:00.000Z",
			},
		}
		expect(formatFermentV2Summary(evaluated)).toContain(
			"Evaluations: 2\nLast evaluation: continue — missing smoke test",
		)
		expect(formatFermentV2Accounting(evaluated)).toBe("<1m · 1.5k tokens")
	})

	it("shows the persisted blocked reason", () => {
		expect(formatFermentV2Summary({ ...fermentV2("blocked"), blockedReason: "needs user input" })).toContain(
			"Blocked reason: needs user input",
		)
	})

	it("formats accounting time in minutes and hours", () => {
		expect(formatFermentV2Duration(249_000)).toBe("4m")
		expect(formatFermentV2Duration(60 * 60_000)).toBe("1h")
		expect(formatFermentV2Duration(65 * 60_000)).toBe("1h 5m")
		expect(formatFermentV2Accounting(fermentV2("active"))).toBe("<1m · 1.5k tokens")
		expect(formatFermentV2Accounting({ ...fermentV2("active"), timeUsedMs: 19 * 60_000 })).toBe("19m · 1.5k tokens")
		expect(formatFermentV2Accounting({ ...fermentV2("active"), timeUsedMs: 65 * 60_000 })).toBe("1h 5m · 1.5k tokens")
		expect(formatFermentV2Accounting({ ...fermentV2("active"), tokenBudget: 2_000 })).toBe("<1m · 1.5k/2.0k tokens")
	})
})

function fermentV2(status: FermentV2Status): SessionFermentV2 {
	return {
		schemaVersion: 1,
		id: "ferment-v2-a",
		revision: 3,
		objective: "ship it",
		status,
		tokensUsed: 1_500,
		timeUsedMs: 2_000,
		createdAt: "2026-07-16T10:00:00.000Z",
		updatedAt: "2026-07-16T10:00:00.000Z",
	}
}
