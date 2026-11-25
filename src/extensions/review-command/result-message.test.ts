import { homedir } from "node:os"
import { join } from "node:path"
import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { testTheme } from "../__mocks__/theme.js"
import { FINDING_SCHEMA_VERSION, type ReviewFindingRecord } from "../review-submit/store.js"
import { sanitizeReviewDisplayText } from "../review-targets/provider-url.js"
import type { ReviewResultDetails } from "./result-message.js"
import {
	REVIEW_RESULT_CUSTOM_TYPE,
	renderReviewResult,
	renderReviewResultLines,
	reviewResultRenderer,
} from "./result-message.js"

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

	it.each([60, 80, 100, 120])("wraps prose and suggestions with one shortened report-path row at width %i", (width) => {
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
		expect(normalized).toContain("Fix: Apply the focused correction and retain the full suggestion while wrapping.")
		const footer = rows.at(-1)
		expect(footer).toContain("ctrl+o to collapse details")
		expect(footer).toContain("final.json")
		expect(visibleWidth(footer ?? "")).toBeLessThanOrEqual(width)
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

const LONG_SHA = "a".repeat(40)
const OTHER_SHA = "b".repeat(40)

function presentationDetails(): ReviewResultDetails {
	return details({
		base: "origin/main",
		findings: [
			finding(
				"src/features/checkout/actions/changes/permissions/reconfirmation/nested/attention/BulkActionsBar.tsx",
				82,
				"P2",
				`At head ${LONG_SHA}, Staged confirmation can outlive the edit permission that opened it. Revision ${OTHER_SHA}. The boundary should be revalidated before approval.`,
			),
			finding(
				"BulkActionsBar.tsx",
				31,
				"P4",
				`Component docblock attached to the wrong declaration. See \`FileNavigator\` and ${OTHER_SHA}.\n\nThe owner should be the declaration, not a sibling wrapper.`,
			),
		],
		summaryPath: join(
			homedir(),
			"Documents",
			"deep",
			"recent",
			"output",
			"nested",
			"review-artifacts",
			"summary",
			"final.json",
		),
	})
}

describe("expanded and collapsed result presentation", () => {
	it.each([80, 120])("renders two compact rows per finding at width %i", (width) => {
		const rows = renderReviewResultLines(presentationDetails(), undefined, width, false)
		expect(rows).toHaveLength(8)
		expect(rows[0]).toContain("Review done · 2 findings (1 P2, 1 P4) · feature → origin/main")
		expect(rows[1]).toBe("")
		expect(rows[2]).toMatch(/^ ▲ P2 /)
		expect(rows[2]).toContain(
			width === 80
				? "…"
				: "src/features/checkout/actions/changes/permissions/reconfirmation/nested/attention/BulkActionsBar.tsx:82",
		)
		expect(rows[2]).toContain("BulkActionsBar.tsx:82")
		expect(rows[3]).toBe("  Staged confirmation can outlive the edit permission that opened it.")
		expect(rows[4]).toMatch(/^ ● P4/)
		expect(rows[5]).toBe("  Component docblock attached to the wrong declaration.")
		expect(rows[6]).toBe("")
		expect(rows[7]).toContain("ctrl+o to expand details · report: ~")
		expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
	})

	it.each([
		`At head ${LONG_SHA},`,
		`Revision ${LONG_SHA}.`,
		`At pinned head ${LONG_SHA},`,
	])("derives a title after stripping boilerplate: %s", (prefix) => {
		const rows = renderReviewResultLines(
			details({
				findings: [finding("value.ts", 42, "P2", `${prefix} Staged confirmation can outlive the edit.`)],
			}),
			undefined,
			80,
			false,
		)
		expect(rows.some((row) => row === "  Staged confirmation can outlive the edit.")).toBe(true)
		expect(rows.join("\n")).not.toContain(LONG_SHA)
	})

	it.each([80, 120])("expands full prose, inline code, SHAs, suggestions and report paths at width %i", (width) => {
		const rows = renderReviewResultLines(presentationDetails(), testTheme, width, true)
		const text = sanitizeReviewDisplayText(rows.join(" "))
		expect(text).toContain("Staged confirmation can outlive the edit permission that opened it.")
		expect(text).toContain("The owner should be the declaration, not a sibling wrapper.")
		expect(text).toContain(LONG_SHA.slice(0, 7))
		expect(text).toContain(OTHER_SHA.slice(0, 7))
		expect(text).not.toContain(LONG_SHA)
		expect(text).not.toContain(OTHER_SHA)
		expect(text).not.toContain("`FileNavigator`")
		expect(text).toContain("Fix:")
		expect(text).toContain("ctrl+o to collapse details")
		expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
		const descriptionRows = rows.filter(
			(row) => row.trim() && !row.trim().startsWith("✔") && !row.trim().startsWith("ctrl+o"),
		)
		expect(descriptionRows.some((row) => visibleWidth(row.trim()) >= 80)).toBe(true)
	})

	it("uses the standard renderer expanded option while keeping the legacy fallback intact", () => {
		const source = presentationDetails()
		const message = {
			role: "custom" as const,
			customType: REVIEW_RESULT_CUSTOM_TYPE,
			content: "",
			display: true,
			details: source,
			timestamp: 0,
		}
		const collapsed = reviewResultRenderer(message, { expanded: false, outputPad: 1 }, testTheme)
		const expanded = reviewResultRenderer(message, { expanded: true, outputPad: 1 }, testTheme)
		if (!collapsed || !expanded) throw new Error("Expected the review renderer")
		const compactRows = collapsed.render(80)
		const expandedRows = expanded.render(120)
		expect(compactRows.some((row) => row.includes("ctrl+o to expand details"))).toBe(true)
		expect(expandedRows.some((row) => row.includes("ctrl+o to collapse details"))).toBe(true)
		expect(compactRows.every((row) => visibleWidth(row) <= 80)).toBe(true)
		expect(expandedRows.every((row) => visibleWidth(row) <= 120)).toBe(true)
		const fallback = renderReviewResult(source)
		expect(fallback).toContain("Suggestion:")
		expect(fallback).toContain(" Report:")
		expect(fallback).not.toContain("ctrl+o")
		expect(fallback).toContain(LONG_SHA)
		expect(fallback).toContain(source.summaryPath)
	})
})
