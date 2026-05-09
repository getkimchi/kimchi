import { describe, expect, it } from "vitest"
import {
	DELTA_COUNT_THRESHOLD,
	evaluatePhaseFeedback,
	renderDeltas,
	renderSelfImprovementSection,
} from "./self-improve.js"
import type { JudgeGrade } from "./types.js"

function grade(g: JudgeGrade["grade"], deltas: JudgeGrade["deltas"] = []): JudgeGrade {
	return { grade: g, rationale: "test", gradedAt: new Date().toISOString(), deltas }
}

describe("evaluatePhaseFeedback", () => {
	it("A grade — continue strategy, no triggers", () => {
		const f = evaluatePhaseFeedback(grade("A"))
		expect(f.adjustment).toBe("Continue current strategy.")
		expect(f.deltaCountTriggered).toBe(false)
		expect(f.correctiveStepNeeded).toBe(false)
	})

	it("B grade — minor adjustments", () => {
		const f = evaluatePhaseFeedback(
			grade("B", [{ category: "quality", expected: "fast", actual: "slow", severity: "minor" }]),
		)
		expect(f.adjustment).toBe("Minor adjustments may improve outcomes.")
		expect(f.correctiveStepNeeded).toBe(false)
	})

	it("C grade — review approach + corrective step NOT needed", () => {
		const f = evaluatePhaseFeedback(grade("C"))
		expect(f.adjustment).toContain("Review approach")
		expect(f.correctiveStepNeeded).toBe(false)
	})

	it("D grade — significant changes + corrective step needed", () => {
		const f = evaluatePhaseFeedback(grade("D"))
		expect(f.adjustment).toContain("Significant changes")
		expect(f.correctiveStepNeeded).toBe(true)
	})

	it("F grade — rethink + corrective step needed", () => {
		const f = evaluatePhaseFeedback(grade("F"))
		expect(f.adjustment).toContain("Rethink")
		expect(f.correctiveStepNeeded).toBe(true)
	})

	it("delta count above threshold triggers strategy review even on A", () => {
		const manyDeltas = Array.from({ length: DELTA_COUNT_THRESHOLD + 1 }, (_, i) => ({
			category: "quality" as const,
			expected: `e${i}`,
			actual: `a${i}`,
			severity: "minor" as const,
		}))
		const f = evaluatePhaseFeedback(grade("A", manyDeltas))
		expect(f.deltaCountTriggered).toBe(true)
		expect(f.adjustment).toContain("gaps")
	})

	it("delta count above threshold triggers on B too", () => {
		const manyDeltas = Array.from({ length: DELTA_COUNT_THRESHOLD + 1 }, (_, i) => ({
			category: "scope" as const,
			expected: `e${i}`,
			actual: `a${i}`,
			severity: "minor" as const,
		}))
		const f = evaluatePhaseFeedback(grade("B", manyDeltas))
		expect(f.deltaCountTriggered).toBe(true)
		expect(f.adjustment).toContain("Multiple gaps")
	})

	it("delta count at exactly threshold does NOT trigger", () => {
		const exactlyAtThreshold = Array.from({ length: DELTA_COUNT_THRESHOLD }, (_, i) => ({
			category: "scope" as const,
			expected: `e${i}`,
			actual: `a${i}`,
			severity: "minor" as const,
		}))
		const f = evaluatePhaseFeedback(grade("A", exactlyAtThreshold))
		expect(f.deltaCountTriggered).toBe(false)
	})
})

describe("renderDeltas", () => {
	it("returns (none) when empty", () => {
		expect(renderDeltas(grade("A"))).toBe("(none)")
	})

	it("renders each delta on its own line with category/expected/actual/severity", () => {
		const g = grade("C", [
			{ category: "scope", expected: "all features", actual: "two features", severity: "major" },
			{ category: "quality", expected: "tests pass", actual: "one failing", severity: "minor" },
		])
		const out = renderDeltas(g)
		expect(out).toContain("[scope]")
		expect(out).toContain("[quality]")
		expect(out).toContain("major")
		expect(out).toContain("minor")
		expect(out.split("\n")).toHaveLength(2)
	})
})

describe("renderSelfImprovementSection", () => {
	it("includes grade, rationale, deltas, and adjustment", () => {
		const g = grade("C", [{ category: "quality", expected: "fast", actual: "slow", severity: "minor" }])
		const f = evaluatePhaseFeedback(g)
		const section = renderSelfImprovementSection(g, f)
		expect(section).toContain("grade C")
		expect(section).toContain("test") // rationale
		expect(section).toContain("[quality]")
		expect(section).toContain("Adjustment")
	})

	it("appends corrective step when supplied", () => {
		const g = grade("F", [{ category: "correctness", expected: "works", actual: "broken", severity: "major" }])
		const f = evaluatePhaseFeedback(g)
		const section = renderSelfImprovementSection(g, f, "Add a regression test for X.")
		expect(section).toContain("Suggested corrective step")
		expect(section).toContain("Add a regression test for X.")
	})

	it("surfaces delta-count override when triggered on a B grade", () => {
		const manyDeltas = Array.from({ length: DELTA_COUNT_THRESHOLD + 1 }, (_, i) => ({
			category: "scope" as const,
			expected: `e${i}`,
			actual: `a${i}`,
			severity: "minor" as const,
		}))
		const g = grade("B", manyDeltas)
		const f = evaluatePhaseFeedback(g)
		const section = renderSelfImprovementSection(g, f)
		expect(section).toContain("exceeded threshold")
	})
})
