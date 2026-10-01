import { describe, expect, it } from "vitest"
import {
	FERMENT_V2_COMMAND_COMPLETIONS,
	formatFermentV2Accounting,
	formatFermentV2Duration,
	formatFermentV2Status,
	formatFermentV2Summary,
	parseFermentV2Command,
} from "./command.js"
import { FERMENT_V2_STATUSES, type FermentV2Status, type SessionFermentV2 } from "./types.js"

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

		expect(manual.startsWith("Ferment V2: ship it\n")).toBe(true)
		expect(automatic).toContain("Plan execution: Cache Layer")
		expect(automatic).toContain("Commands: /ferment-v2 edit, /ferment-v2 pause, /ferment-v2 clear")
	})

	describe.each(FERMENT_V2_STATUSES)("approved plan summary while %s", (status) => {
		it.each([
			"/tmp/cache-layer.md",
			undefined,
		])("shows only the saved reference (%s), preserving the snapshot", (planPath) => {
			const run = {
				...fermentV2(status),
				objective: "Internal approved objective with exact requirements.",
				presentation: {
					kind: "approved-plan",
					title: "Cache Layer",
					planPath,
					planText: "# Full approved Markdown\nDo not repeat this in a summary.",
				},
			} satisfies SessionFermentV2
			const before = structuredClone(run)
			const summary = formatFermentV2Summary(run)
			expect(summary).toContain(`Plan: ${planPath ?? "no saved file"}`)
			expect(summary).toContain(`Status: ${status}`)
			expect(summary).not.toContain("Objective:")
			expect(summary).not.toContain(run.objective)
			expect(summary).not.toContain(run.presentation.planText)
			expect(run).toEqual(before)
		})
	})

	it("shows the run state and resume hint without adding a prompt decoration", () => {
		expect(formatFermentV2Status(undefined)).toBeUndefined()
		expect(formatFermentV2Status(fermentV2("active"))).toBe("◈ Ferment V2: running · ship it")
		expect(formatFermentV2Status(fermentV2("active"), true)).toBe("◈ Ferment V2: checking · ship it")
		expect(formatFermentV2Status(fermentV2("paused"), true)).toBe("◈ Ferment V2: paused · ship it · /ferment-v2 resume")
		expect(formatFermentV2Status(fermentV2("blocked"))).toBe("◈ Ferment V2: blocked · ship it · /ferment-v2 resume")
		expect(formatFermentV2Status(fermentV2("complete"))).toBe("◈ Ferment V2: complete · ship it")
		expect(formatFermentV2Status(fermentV2("budget_limited"))).toBe("◈ Ferment V2: budget limited · ship it")
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

	it("shows a bounded name in the footer and the complete objective in the summary", () => {
		const objective =
			"Implement a streaming parser with incremental input and preserve every existing API and test case"
		const run = { ...fermentV2("active"), objective }
		const status = formatFermentV2Status(run)
		expect(status).toBe("◈ Ferment V2: running · Implement a streaming parser with")
		expect(formatFermentV2Summary(run)).toContain(`Objective: ${objective}`)
		expect(formatFermentV2Status({ ...run, name: "Streaming parser" })).toBe("◈ Ferment V2: running · Streaming parser")
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
