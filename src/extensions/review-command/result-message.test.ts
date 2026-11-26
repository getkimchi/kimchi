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

const WIDTHS = [60, 80, 120] as const

function finding(
	path: string,
	line: number,
	priority: ReviewFindingRecord["priority"],
	description = "A finding.",
	overrides: Partial<ReviewFindingRecord> = {},
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
		...overrides,
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

function plain(rows: readonly string[]): string {
	return rows
		.map((row) => sanitizeReviewDisplayText(row).trim())
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim()
}

describe("legacy review result content", () => {
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

	it("keeps the zero-finding summary without a legacy no-findings block", () => {
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
				{ title: "Revalidate the permission boundary" },
			),
			finding(
				"BulkActionsBar.tsx",
				31,
				"P4",
				`Component docblock attached to the wrong declaration. See \`FileNavigator\` and ${OTHER_SHA}.\n\nThe owner should be the declaration, not a sibling wrapper.`,
			),
			finding("src/Other.ts", 12, "P4", "A second low-priority description that stays out of the compact list.", {
				title: "Document the sibling export contract",
			}),
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
	it.each(WIDTHS)("groups titled findings and collapses P4 rows at width %i", (width) => {
		const source = presentationDetails()
		const rows = renderReviewResultLines(source, undefined, width, false)
		const text = plain(rows)
		expect(rows[0]).toContain("Review done · 3 findings (1 P2, 2 P4)")
		expect(rows.filter((row) => ["P0", "P1", "P2", "P3", "P4"].includes(row))).toEqual(["P2", "P4"])
		const titleIndex = rows.findIndex((row) => row.includes("P2 · bug · Revalidate the permission boundary"))
		expect(titleIndex).toBeGreaterThan(0)
		expect(rows[titleIndex + 1]).toContain("BulkActionsBar.tsx:82")
		const descriptionEnd = rows.indexOf("", titleIndex + 2)
		expect(descriptionEnd - titleIndex - 2).toBeLessThanOrEqual(2)
		expect(text).not.toContain("Static inspection confirms this fixture finding.")
		expect(text).not.toContain("Apply the focused correction")
		for (const lowPriority of source.findings.filter((record) => record.priority === "P4")) {
			const row = rows.find((candidate) => candidate.includes(lowPriority.title))
			expect(row).toContain(`${lowPriority.path}:${lowPriority.line}`)
			expect(row).not.toContain(lowPriority.description)
		}
		expect(rows.at(-1)).toContain("ctrl+o for full details · report: ~")
		expect(rows.at(-1)).toContain("final.json")
		expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
	})

	it.each(WIDTHS)("wraps a collapsed description to at most two lines with an ellipsis at width %i", (width) => {
		const description =
			"The complete description is deliberately long enough to exceed two terminal rows at every tested width. ".repeat(
				5,
			)
		const rows = renderReviewResultLines(
			details({ findings: [finding("src/value.ts", 42, "P1", description)] }),
			undefined,
			width,
			false,
		)
		const titleIndex = rows.findIndex((row) => row.includes("P1 finding title"))
		const end = rows.indexOf("", titleIndex + 2)
		const descriptionRows = rows.slice(titleIndex + 2, end)
		expect(descriptionRows).toHaveLength(2)
		expect(sanitizeReviewDisplayText(descriptionRows[1] ?? "").endsWith("…")).toBe(true)
		expect(plain(rows)).not.toContain(description)
		expect(plain(rows).includes("Static inspection confirms")).toBe(false)
		expect(plain(rows).includes("Apply the focused correction")).toBe(false)
	})

	it("uses the record title and type rather than deriving a title from the description", () => {
		const rows = renderReviewResultLines(
			details({
				findings: [
					finding("value.ts", 42, "P3", "A description that must not become a generated title.", {
						title: "Persisted finding title",
						type: "reliability",
					}),
				],
			}),
			undefined,
			80,
			false,
		)
		const title = rows.find((row) => row.includes("P3 · reliability · Persisted finding title"))
		expect(title).toBeDefined()
		expect(title).not.toContain("A description that must not become")
	})

	it.each(WIDTHS)("expands every full description, explanation and suggestion at width %i", (width) => {
		const source = presentationDetails()
		const rows = renderReviewResultLines(source, testTheme, width, true)
		const text = plain(rows)
		for (const record of source.findings) {
			expect(text).toContain(record.description.replace(/[`\s]+/g, " ").trim())
			expect(text).toContain(record.explanation.replace(/\s+/g, " "))
			expect(text).toContain(record.suggestion.replace(/\s+/g, " "))
		}
		expect(text).toContain(LONG_SHA)
		expect(text).toContain(OTHER_SHA)
		expect(text).not.toContain("`FileNavigator`")
		expect(text).toContain("Explanation:")
		expect(text).toContain("Suggestion:")
		expect(text).toContain("ctrl+o to collapse details")
		expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
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
		expect(compactRows.some((row) => row.includes("ctrl+o for full details"))).toBe(true)
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

	it("says No issues found once for an empty result", () => {
		const rows = renderReviewResultLines(details(), undefined, 80, false)
		expect(rows[0]).toBe("No issues found")
		expect(rows.filter((row) => row.includes("No issues found"))).toHaveLength(1)
		expect(plain(rows)).not.toContain("no findings")
		expect(plain(rows)).not.toContain("No findings.")
	})

	it("colors each non-empty priority group with its finding theme color", () => {
		const rows = renderReviewResultLines(
			details({ findings: [finding("critical.ts", 1, "P1"), finding("info.ts", 2, "P4")] }),
			testTheme,
			80,
			false,
		)
		expect(rows).toContain(testTheme.bold(testTheme.fg("warning", "P1")))
		expect(rows).toContain(testTheme.bold(testTheme.fg("accent", "P4")))
	})

	it("does not duplicate review or coverage status lines", () => {
		const rows = renderReviewResultLines(
			details({
				coverage: { ...details().coverage, status: "partial", unfinished_lenses: ["spec"] },
				findings: [finding("value.ts", 2, "P1")],
			}),
			undefined,
			80,
			false,
		)
		const text = rows.join("\n")
		expect(rows.filter((row) => row.includes("Review incomplete"))).toHaveLength(1)
		expect(rows.filter((row) => row.includes("Partial coverage:"))).toHaveLength(1)
		expect(text).not.toContain("Review complete:")
		expect(text).not.toContain("Complete review coverage.")
	})
})

describe("result width and Unicode safety", () => {
	it.each(WIDTHS)("fits long titles, long paths, CJK and emoji within width %i", (width) => {
		const source = details({
			findings: [
				finding(
					`${"src/非常に長いディレクトリ/".repeat(3)}checkout/💥/AuthorizationHandler.ts`,
					82,
					"P1",
					"長い説明文 🚨 ".repeat(40),
					{ title: "認可チェックを再検証してください 🚨 ".repeat(6), type: "security" },
				),
			],
			summaryPath: `/private/var/folders/review/${"long-output-segment/".repeat(6)}summary/final.json`,
		})
		for (const expanded of [false, true]) {
			const rows = renderReviewResultLines(source, testTheme, width, expanded, 1)
			expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
			expect(rows.some((row) => row.includes("…"))).toBe(true)
			expect(rows.at(-1)).toContain("final.json")
			if (!expanded) {
				const titleIndex = rows.findIndex((row) => row.includes("P1 · security ·"))
				const descriptionEnd = rows.indexOf("", titleIndex + 2)
				expect(descriptionEnd - titleIndex - 2).toBeLessThanOrEqual(2)
			}
		}
	})
})
