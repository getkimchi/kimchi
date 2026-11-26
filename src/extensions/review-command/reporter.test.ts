import { Text } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import { createCommandContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { type ReviewPanelSelectionInput, resolveReviewPanel } from "../review-panel/lenses.js"
import type { ReviewPanelProgress, ReviewPanelResult } from "../review-panel/types.js"
import { FINDING_SCHEMA_VERSION } from "../review-submit/store.js"
import type { ResolvedReviewTarget } from "../review-targets/types.js"
import { reporter } from "./command.js"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const CHECKOUT_PATH = `/tmp/${"checkout-path-segment/".repeat(16)}repository`
const RUN_DIRECTORY = `${CHECKOUT_PATH}/.kimchi/review-output/runs/${"run-segment-".repeat(16)}`
const LONG_REASON_SUFFIX =
	"because an explicitly verbose policy requires additional context that must remain available without repeating during progress refreshes"
const FINDING_TITLE = "The new export lacks a behavior guard"
const FINDING_DESCRIPTION = "The new export changes behavior without a guard."
const WIDTHS = [60, 80, 120] as const

function target(): ResolvedReviewTarget {
	return {
		scope: {
			kind: "working-tree",
			refs: { base: "main", resolvedBase: BASE_SHA, head: HEAD_SHA },
			includeWorkingTree: true,
			baseSource: "explicit",
			pinned: { baseSha: BASE_SHA, headSha: HEAD_SHA, tipSha: HEAD_SHA },
			headKind: "working-tree-snapshot",
			dirty: true,
			files: { changed: 3, anchorable: 3, unanchorable: 0 },
			anchorSource: "local",
			checkoutPath: CHECKOUT_PATH,
			contextDir: `${CHECKOUT_PATH}/.kimchi/review-context`,
			commentableLinesPath: `${CHECKOUT_PATH}/.kimchi/review-context/commentable-lines.json`,
			limitations: [],
		},
		cleanup: async () => {},
	}
}

function selection(input: ReviewPanelSelectionInput): ReturnType<typeof resolveReviewPanel> {
	const selected = resolveReviewPanel(input)
	return {
		...selected,
		lenses: selected.lenses.map((lens) => ({
			...lens,
			reasons: [...lens.reasons, `${lens.id}: ${lens.reasons.join("; ")} ${LONG_REASON_SUFFIX}`],
		})),
	}
}

function coverage(lensCount: number): ReviewPanelProgress["coverage"] {
	return {
		status: "complete",
		unfinished_lenses: [],
		selected_lenses: lensCount,
		submitted_lenses: lensCount,
		failed_lenses: 0,
		cancelled_lenses: 0,
		candidate_count: lensCount,
		final_finding_count: 1,
		provenance_truncated_count: 0,
		findings_by_priority: { P0: 0, P1: 0, P2: 1, P3: 0, P4: 0 },
	}
}

function progress(selected: ReturnType<typeof selection>, complete: boolean): ReviewPanelProgress {
	return {
		phase: complete ? "complete" : "reviewing",
		lenses: selected.lenses.map((lens, index) => ({
			id: lens.id,
			writer: lens.writer,
			status: !complete && index === 0 ? "running" : "submitted",
			reasons: lens.reasons,
			candidateCount: 1,
		})),
		counts: {
			queued: 0,
			running: complete ? 0 : 1,
			submitted: complete ? selected.lenses.length : selected.lenses.length - 1,
			failed: 0,
			cancelled: 0,
			candidates: selected.lenses.length,
		},
		coverage: coverage(selected.lenses.length),
		reconciliation: complete
			? { status: "reconciled", reason: "All candidates reconciled." }
			: { status: "pending", reason: "Reconciliation pending." },
	}
}

function result(
	selected: ReturnType<typeof selection>,
): Pick<ReviewPanelResult, "progress" | "findings" | "summaryPath"> {
	return {
		progress: progress(selected, true),
		findings: [
			{
				schema_version: FINDING_SCHEMA_VERSION,
				id: "finding-1",
				writer: "final",
				seq: 1,
				created_at: "2026-11-25T12:00:00Z",
				path: `${CHECKOUT_PATH}/src/value.ts`,
				line: 2,
				title: FINDING_TITLE,
				description: FINDING_DESCRIPTION,
				explanation: "Static inspection of the changed export shows the missing guard.",
				suggestion: "Guard the changed behavior.",
				priority: "P2",
				type: "bug",
				derived_from: ["candidate-1"],
			},
		],
		summaryPath: `${RUN_DIRECTORY}/summary/final.json`,
	}
}

function expectAtMostTenRenderedRows(ctx: ReturnType<typeof createCommandContext>, width: number, phase: string): void {
	const content = vi.mocked(ctx.ui.setWidget).mock.calls.at(-1)?.[1]
	expect(Array.isArray(content), `${phase} must supply text lines`).toBe(true)
	if (!Array.isArray(content)) return
	const rows = content.flatMap((line) => new Text(line, 1, 0).render(width))
	expect(rows.length, `${phase} at width ${width}:\n${rows.join("\n")}`).toBeLessThanOrEqual(10)
}

function occurrences(text: string, value: string): number {
	return text.split(value).length - 1
}

const cases = [
	{ name: "single-lens panel", input: { lenses: ["spec"], concurrency: 1 }, lensCount: 1 },
	{ name: "default four-lens panel", input: { concurrency: 2 }, lensCount: 4 },
	{ name: "--all five-lens panel", input: { all: true, concurrency: 2 }, lensCount: 5 },
] satisfies Array<{ name: string; input: ReviewPanelSelectionInput; lensCount: number }>

describe("review command reporter", () => {
	for (const testCase of cases) {
		for (const width of WIDTHS) {
			it(`keeps every phase of the ${testCase.name} within 10 rendered rows at width ${width}`, () => {
				const ctx = createCommandContext()
				const { api, sendMessage } = createExtensionApi()
				const selected = selection(testCase.input)
				expect(selected.lenses).toHaveLength(testCase.lensCount)
				const report = reporter(ctx, true, api)
				report.scope(target(), RUN_DIRECTORY)
				expectAtMostTenRenderedRows(ctx, width, "scope")
				report.selection(selected)
				expectAtMostTenRenderedRows(ctx, width, "selection")
				report.progress(progress(selected, false))
				expectAtMostTenRenderedRows(ctx, width, "progress")
				report.error(new Error(`Failure with extended diagnostics: ${"error detail ".repeat(40)}`))
				expectAtMostTenRenderedRows(ctx, width, "error")
				report.result(result(selected))
				expectAtMostTenRenderedRows(ctx, width, "result")
				expect(vi.mocked(ctx.ui.setWidget).mock.calls.at(-1)?.[1]).toEqual([
					"Review complete: 1 final finding.",
					"Complete review coverage.",
				])

				expect(sendMessage).toHaveBeenCalledTimes(2)
				const transcript = [
					...sendMessage.mock.calls.map(([message]) => String(message.content)),
					...vi.mocked(ctx.ui.notify).mock.calls.map(([message]) => message),
				].join("\n")
				expect(occurrences(transcript, `${BASE_SHA}..${HEAD_SHA}`)).toBe(1)
				expect(occurrences(transcript, CHECKOUT_PATH)).toBeGreaterThanOrEqual(1)
				expect(occurrences(transcript, RUN_DIRECTORY)).toBeGreaterThanOrEqual(1)
				for (const lens of selected.lenses) {
					expect(occurrences(transcript, lens.reasons[1] ?? "")).toBe(1)
				}
				expect(transcript).toContain(`Effective concurrency: ${selected.slotCount}`)
				expect(transcript).toContain("Complete review coverage.")
				expect(transcript).toContain(FINDING_TITLE)
				expect(transcript).toContain(`Report: ${RUN_DIRECTORY}/summary/final.json`)
			})
		}
	}
})
