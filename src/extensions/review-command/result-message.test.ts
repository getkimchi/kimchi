import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { testTheme } from "../__mocks__/theme.js"
import { FINDING_SCHEMA_VERSION, type ReviewFindingRecord } from "../review-submit/store.js"
import type { ReviewResultDetails } from "./result-message.js"
import { renderReviewResult, renderReviewResultLines } from "./result-message.js"

function finding(
	path: string,
	line: number,
	priority: ReviewFindingRecord["priority"],
	description = "A finding.",
): ReviewFindingRecord {
	return {
		schema_version: FINDING_SCHEMA_VERSION,
		id: `${priority}-${path}-${line}`,
		writer: "final",
		seq: 1,
		created_at: "2026-11-25T12:00:00Z",
		path,
		line,
		title: `${priority} finding title`,
		description,
		explanation: "Static inspection confirms this fixture finding.",
		suggestion: "Apply the focused correction and retain the full suggestion while wrapping.",
		priority,
		type: "bug",
	}
}

function details(overrides: Partial<ReviewResultDetails> = {}): ReviewResultDetails {
	return {
		branch: "feature",
		base: "main",
		findings: [],
		coverage: {
			status: "complete",
			unfinished_lenses: [],
			selected_lenses: 2,
			submitted_lenses: 2,
			failed_lenses: 0,
			cancelled_lenses: 0,
			candidate_count: 0,
			final_finding_count: 0,
			provenance_truncated_count: 0,
			findings_by_priority: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 },
		},
		summaryPath: "/tmp/review/summary/final.json",
		...overrides,
	}
}

describe("review result message", () => {
	it("sorts P0 through P4, followed by path and line", () => {
		const output = renderReviewResult(
			details({
				findings: [
					finding("z.ts", 2, "P4", "P4 Z"),
					finding("b.ts", 2, "P2", "P2 B"),
					finding("z.ts", 4, "P0", "P0"),
					finding("a.ts", 10, "P2", "P2 A"),
					finding("a.ts", 1, "P4", "P4 A"),
				],
			}),
		)
		const order = ["z.ts:4", "a.ts:10", "b.ts:2", "a.ts:1\n", "z.ts:2"].map((value) => output.indexOf(value))
		expect(order).toEqual([...order].sort((left, right) => left - right))
		expect(output).toContain("5 findings (1 P0, 2 P2, 2 P4)")
	})

	it("uses an incomplete yellow headline when at least one lens submitted", () => {
		const output = renderReviewResult(
			details({
				coverage: {
					...details().coverage,
					status: "partial",
					unfinished_lenses: ["standards"],
					submitted_lenses: 1,
				},
			}),
			testTheme,
		)
		expect(output).toContain(testTheme.fg("warning", "▲ Review incomplete · no findings · feature → main"))
		expect(output).not.toContain("✔ Review done")
	})

	it("uses a failed red headline when no lens submitted", () => {
		const output = renderReviewResult(
			details({
				coverage: {
					...details().coverage,
					status: "partial",
					unfinished_lenses: ["spec"],
					submitted_lenses: 0,
				},
			}),
			testTheme,
		)
		expect(output).toContain(testTheme.fg("error", "✖ Review failed · no findings · feature → main"))
		expect(output).not.toContain("✔ Review done")
	})

	it("uses the zero-finding summary without a legacy no-findings block", () => {
		const output = renderReviewResult(details())
		expect(output).toContain("✔ Review done · no findings · feature → main")
		expect(output).not.toContain("No findings.")
		expect(output.trimEnd().endsWith(" Report:\n  /tmp/review/summary/final.json")).toBe(true)
	})

	it("adds one partial-coverage line before findings", () => {
		const output = renderReviewResult(
			details({
				coverage: { ...details().coverage, status: "partial", unfinished_lenses: ["spec", "security"] },
				findings: [finding("value.ts", 2, "P1")],
			}),
		)
		expect(output.split("\n").filter((line) => line.startsWith("▲ Partial coverage:"))).toHaveLength(1)
		expect(output.indexOf("▲ Partial coverage: spec, security did not finish.")).toBeLessThan(
			output.indexOf("value.ts:2"),
		)
	})

	it.each([
		60, 80, 100, 120,
	])("wraps full text with hanging indents and a lossless report path at width %i", (width) => {
		const description =
			"The reviewer found a behavior change whose complete explanation must remain visible after wrapping across several terminal rows."
		const summaryPath = `/private/var/folders/review/${"long-output-segment/".repeat(6)}summary/final.json`
		const rows = renderReviewResultLines(
			details({ findings: [finding("src/feature/value.ts", 42, "P4", description)], summaryPath }),
			undefined,
			width,
		)
		expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
		const normalized = rows.join(" ").replace(/\s+/g, " ")
		expect(normalized).toContain(description)
		expect(normalized).toContain(
			"Suggestion: Apply the focused correction and retain the full suggestion while wrapping.",
		)
		const reportIndex = rows.indexOf(" Report:")
		expect(reportIndex).toBeGreaterThan(0)
		const reportRows = rows.slice(reportIndex + 1)
		expect(reportRows.length).toBeGreaterThan(1)
		expect(reportRows.every((row) => row.startsWith("  "))).toBe(true)
		expect(reportRows.map((row) => row.trim()).join("")).toBe(summaryPath)
		const suggestionIndex = rows.findIndex((row) => row.startsWith("   Suggestion:"))
		expect(suggestionIndex).toBeGreaterThan(0)
		expect(rows.slice(suggestionIndex + 1, reportIndex - 1).every((row) => row.startsWith("   "))).toBe(true)
	})

	it("uses priority colors and bold paths from the active theme", () => {
		const output = renderReviewResult(
			details({ findings: [finding("critical.ts", 1, "P0"), finding("info.ts", 2, "P4")] }),
			testTheme,
		)
		expect(output).toContain("✖ P0")
		expect(output).toContain("● P4")
		expect(output).toContain("\u001b[")
		expect(output).toContain(testTheme.bold("critical.ts:1"))
	})
})
