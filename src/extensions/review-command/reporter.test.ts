import { Text, type TUI } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createCommandContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { testTheme } from "../__mocks__/theme.js"
import { type ReviewPanelSelectionInput, resolveReviewPanel } from "../review-panel/lenses.js"
import type { ReviewPanelProgress, ReviewPanelResult } from "../review-panel/types.js"
import { FINDING_SCHEMA_VERSION } from "../review-submit/store.js"
import type { ResolvedReviewTarget } from "../review-targets/types.js"
import { reporter } from "./command.js"
import { isReviewWidgetMounted, stopReviewProgressAnimation } from "./progress-widget.js"
import { REVIEW_RESULT_CUSTOM_TYPE } from "./result-message.js"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const FINDING_TITLE = "The new export lacks a behavior guard"
const FINDING_DESCRIPTION = "The new export changes behavior without a guard."
const WIDTHS = [60, 80, 120] as const
const contexts = new Set<ReturnType<typeof createCommandContext>>()

function commandContext() {
	const ctx = createCommandContext()
	contexts.add(ctx)
	return ctx
}

afterEach(() => {
	for (const ctx of contexts) stopReviewProgressAnimation(ctx)
	contexts.clear()
	vi.useRealTimers()
})

function target(): ResolvedReviewTarget {
	return {
		scope: {
			kind: "branch",
			refs: { branch: "feature", base: "main", resolvedBase: "refs/heads/main", head: "feature" },
			includeWorkingTree: false,
			baseSource: "explicit",
			pinned: { baseSha: BASE_SHA, headSha: HEAD_SHA, tipSha: HEAD_SHA },
			headKind: "commit",
			dirty: false,
			files: { changed: 3, anchorable: 3, unanchorable: 0 },
			anchorSource: "local",
			checkoutPath: "/private/review/checkout/must-not-appear",
			contextDir: "/private/review/context",
			commentableLinesPath: "/private/review/context/commentable-lines.json",
			limitations: [],
		},
		cleanup: async () => {},
	}
}

function selected(input: ReviewPanelSelectionInput) {
	return resolveReviewPanel(input)
}

function coverage(lensCount: number): ReviewPanelProgress["coverage"] {
	return {
		status: "complete",
		unfinished_lenses: [],
		selected_lenses: lensCount,
		submitted_lenses: lensCount,
		failed_lenses: 0,
		cancelled_lenses: 0,
		candidate_count: 3,
		final_finding_count: 1,
		provenance_truncated_count: 0,
		findings_by_priority: { P0: 0, P1: 0, P2: 1, P3: 0, P4: 0 },
	}
}

function progress(selection: ReturnType<typeof selected>, complete = false): ReviewPanelProgress {
	return {
		phase: complete ? "complete" : "reviewing",
		lenses: selection.lenses.map((lens, index) => ({
			id: lens.id,
			writer: lens.writer,
			status: complete ? "submitted" : index === 0 ? "submitted" : index === 1 ? "running" : "queued",
			reasons: lens.reasons,
			candidateCount: index === 0 ? 2 : index === 1 ? 1 : 0,
			...(index === 2 ? { error: "one concise lens failure" } : {}),
		})),
		counts: {
			queued: complete ? 0 : Math.max(0, selection.lenses.length - 2),
			running: complete || selection.lenses.length < 2 ? 0 : 1,
			submitted: complete ? selection.lenses.length : 1,
			failed: 0,
			cancelled: 0,
			candidates: 3,
		},
		coverage: coverage(selection.lenses.length),
		reconciliation: complete
			? { status: "reconciled", reason: "All candidates reconciled." }
			: { status: "pending", reason: "Reconciliation pending." },
	}
}

function result(
	selection: ReturnType<typeof selected>,
): Pick<ReviewPanelResult, "progress" | "findings" | "summaryPath"> {
	return {
		progress: progress(selection, true),
		findings: [
			{
				schema_version: FINDING_SCHEMA_VERSION,
				id: "finding-1",
				writer: "final",
				seq: 1,
				created_at: "2026-11-25T12:00:00Z",
				path: "src/value.ts",
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
		summaryPath: "/private/review/output/summary/final.json",
	}
}

function widgetRows(ctx: ReturnType<typeof createCommandContext>, width: number): string[] {
	const content = vi.mocked(ctx.ui.setWidget).mock.calls.at(-1)?.[1]
	expect(typeof content).toBe("function")
	if (typeof content !== "function") return []
	const factory = content as unknown as (tui: TUI, theme: typeof testTheme) => { render(width: number): string[] }
	return factory({ requestRender: vi.fn() } as unknown as TUI, testTheme).render(width)
}

function expectWidgetBudget(ctx: ReturnType<typeof createCommandContext>, width: number, phase: string): string[] {
	const rows = widgetRows(ctx, width)
	expect(rows.length, `${phase} at width ${width}:\n${rows.join("\n")}`).toBeLessThanOrEqual(12)
	for (const row of rows) if (row) expect(new Text(row, 0, 0).render(width)).toHaveLength(1)
	return rows
}

const cases = [
	{ name: "single-lens panel", input: { lenses: ["spec"], concurrency: 1 }, lensCount: 1 },
	{ name: "default four-lens panel", input: { concurrency: 2 }, lensCount: 4 },
	{ name: "--all five-lens panel", input: { all: true, concurrency: 2 }, lensCount: 5 },
] satisfies Array<{ name: string; input: ReviewPanelSelectionInput; lensCount: number }>

describe("review command reporter", () => {
	it("animates running lens and stage rows with the shared Pi loader and stops on removal", () => {
		vi.useFakeTimers()
		const ctx = commandContext()
		const { api } = createExtensionApi()
		const selection = selected({ lenses: ["spec", "standards"], concurrency: 1 })
		const report = reporter(ctx, true, api)
		report.scope(target())
		report.selection(selection)
		report.progress(progress(selection))
		const first = widgetRows(ctx, 120).join("\n")
		expect(first).toContain("⠋")
		expect(isReviewWidgetMounted(ctx)).toBe(true)
		vi.advanceTimersByTime(80)
		const next = progress(selection)
		next.phase = "reconciling"
		report.progress(next)
		const second = widgetRows(ctx, 120).join("\n")
		expect(second).toContain("⠙")
		expect(second).toContain("2 Merge")
		expect(second).toContain("2 issues")
		next.phase = "finalizing"
		report.progress(next)
		expect(widgetRows(ctx, 120).find((row) => row.includes("3 Report"))).toContain("⠙")
		expect(vi.getTimerCount()).toBeGreaterThan(0)
		report.result(result(selection))
		expect(vi.getTimerCount()).toBe(0)
		expect(isReviewWidgetMounted(ctx)).toBe(false)
	})

	it("shows no issues dimmed on a completed empty lens and preserves issue counts", () => {
		const ctx = commandContext()
		const { api } = createExtensionApi()
		const selection = selected({ lenses: ["spec"], concurrency: 1 })
		const report = reporter(ctx, true, api)
		report.scope(target())
		report.selection(selection)
		const current = progress(selection, true)
		current.lenses[0].candidateCount = 0
		report.progress(current)
		const row = widgetRows(ctx, 120).find((value) => value.includes("no issues"))
		expect(row).toContain(testTheme.fg("dim", "no issues"))
		expect(row).not.toContain("0 issues")
	})

	it("uses the resolved display base while retaining the symbolic scope ref", () => {
		const ctx = commandContext()
		const { api } = createExtensionApi()
		const report = reporter(ctx, true, api)
		const view = target()
		view.scope.refs.resolvedBase = "refs/remotes/origin/HEAD"
		view.baseDisplayRef = "refs/remotes/origin/main"
		report.scope(view)
		const header = widgetRows(ctx, 120)[0]
		expect(header).toContain("origin/main")
		expect(header).not.toContain("origin/HEAD")
		expect(view.scope.refs.resolvedBase).toBe("refs/remotes/origin/HEAD")
	})

	for (const testCase of cases) {
		for (const width of WIDTHS) {
			it(`keeps the ${testCase.name} within 12 rendered rows at width ${width}`, () => {
				const ctx = commandContext()
				const { api, sendMessage } = createExtensionApi()
				const selection = selected(testCase.input)
				expect(selection.lenses).toHaveLength(testCase.lensCount)
				const report = reporter(ctx, true, api)
				report.scope(target())
				expectWidgetBudget(ctx, width, "scope")
				report.selection(selection)
				expectWidgetBudget(ctx, width, "selection")
				report.progress(progress(selection))
				const rows = expectWidgetBudget(ctx, width, "progress").join("\n")
				expect(rows).toContain("done")
				expect(rows).toContain("2 issues")
				expect(rows).not.toContain("0 issues")
				expect(rows).not.toContain("candidates")
				expect(rows).not.toContain("Effective concurrency")
				expect(rows).not.toContain(target().scope.checkoutPath)
				expect(rows).not.toContain(HEAD_SHA)
				expect(rows).toContain(HEAD_SHA.slice(0, 7))
				report.progress({ ...progress(selection), phase: "reconciling" })
				report.error(new Error(`Failure with extended diagnostics: ${"error detail ".repeat(40)}`))
				expect(expectWidgetBudget(ctx, width, "error").join("\n")).toContain("Review failed:")
				report.result(result(selection))
				expect(vi.mocked(ctx.ui.setWidget).mock.calls.at(-1)?.[1]).toBeUndefined()
				expect(sendMessage).toHaveBeenCalledTimes(1)
				expect(sendMessage.mock.calls[0]?.[0].customType).toBe(REVIEW_RESULT_CUSTOM_TYPE)
				expect(String(sendMessage.mock.calls[0]?.[0].content)).toContain("✔ Review done · 1 finding (1 P2)")
				for (const notification of vi.mocked(ctx.ui.notify).mock.calls) {
					expect(notification[0]).not.toContain("Review complete:")
					expect(notification[0]).not.toContain("Complete review coverage.")
				}
			})
		}
	}

	it("renders issue states, stage mapping, PR title, and theme colors", () => {
		const ctx = commandContext()
		const { api } = createExtensionApi()
		const report = reporter(ctx, true, api)
		const prTarget = target()
		prTarget.scope.pullRequest = {
			provider: "github",
			url: "https://github.com/owner/repository/pull/42",
			number: 42,
			title: "Improve review target handling",
			reportedHeadSha: HEAD_SHA,
			headMoved: false,
		}
		const selection = selected({ all: true })
		report.scope(prTarget)
		report.selection(selection)
		const current = progress(selection)
		current.phase = "reconciling"
		current.lenses[0].status = "submitted"
		current.lenses[0].candidateCount = 2
		current.lenses[1].status = "running"
		current.lenses[1].candidateCount = 1
		current.lenses[2].status = "failed"
		current.lenses[2].error = `A concise lens failure ${"detail ".repeat(20)}`
		current.reconciliation = { status: "fallback", reason: "Durable fallback published." }
		report.progress(current)
		const rows = expectWidgetBudget(ctx, 120, "states")
		const output = rows.join("\n")
		expect(output).toContain("Improve review target handling")
		expect(output).toContain("2 issues")
		expect(output).toContain("1 issue so far")
		expect(output).toContain("A concise lens failure")
		expect(output).toContain("dedupe & verify issues")
		expect(output).toContain("write findings")
		expect(output).toContain("\u001b[")
		const green = testTheme.fg("success", "marker").split("marker")[0]
		const yellow = testTheme.fg("warning", "marker").split("marker")[0]
		const red = testTheme.fg("error", "marker").split("marker")[0]
		expect(rows.find((row) => row.includes("● spec"))?.startsWith(green)).toBe(true)
		expect(rows.find((row) => row.includes("standards"))?.startsWith(yellow)).toBe(true)
		expect(rows.find((row) => row.includes("✖ operational"))?.startsWith(red)).toBe(true)
		expect(rows.find((row) => row.includes("2 Merge"))?.startsWith(yellow)).toBe(true)
		const dim = testTheme.fg("dim", "marker").split("marker")[0]
		expect(rows.find((row) => row.includes("3 Report"))?.startsWith(dim)).toBe(true)
		expect(rows.length).toBeLessThanOrEqual(12)

		current.phase = "finalizing"
		report.progress(current)
		const finalizingRows = widgetRows(ctx, 120)
		expect(finalizingRows.find((row) => row.includes("2 Merge"))?.startsWith(green)).toBe(true)
		expect(finalizingRows.find((row) => row.includes("3 Report"))?.startsWith(yellow)).toBe(true)
	})

	it("uses singular file wording and does not fail Merge before it starts", () => {
		const ctx = commandContext()
		const { api } = createExtensionApi()
		const report = reporter(ctx, true, api)
		const oneFile = target()
		oneFile.scope.files = { changed: 1, anchorable: 1, unanchorable: 0 }
		const selection = selected({ lenses: ["spec"] })
		report.scope(oneFile)
		report.selection(selection)
		const current = progress(selection)
		current.reconciliation = { status: "fallback", reason: "An early fallback checkpoint." }
		report.progress(current)
		report.error(new Error("reviewer failed before reconciliation"))
		const rows = widgetRows(ctx, 120)
		expect(rows[0]).toContain("1 file ·")
		expect(rows[0]).not.toContain("1 files")
		const merge = rows.find((row) => row.includes("2 Merge"))
		expect(merge).not.toContain("✖")
		expect(merge).toContain("○")
	})

	it("suppresses the TUI-only finalizing phase on non-TUI surfaces", () => {
		const ctx = commandContext()
		ctx.mode = "rpc"
		const { api } = createExtensionApi()
		const report = reporter(ctx, true, api)
		const selection = selected({ lenses: ["spec"], concurrency: 1 })
		report.scope(target())
		report.selection(selection)
		report.progress({ ...progress(selection), phase: "reconciling" })
		const priorCall = vi.mocked(ctx.ui.setWidget).mock.calls.at(-1)
		const updateCount = vi.mocked(ctx.ui.setWidget).mock.calls.length
		report.progress({ ...progress(selection), phase: "finalizing" })
		const finalCall = vi.mocked(ctx.ui.setWidget).mock.calls.at(-1)
		expect(finalCall).toEqual(priorCall)
		expect(vi.mocked(ctx.ui.setWidget).mock.calls).toHaveLength(updateCount)
		expect(JSON.stringify(finalCall)).not.toContain("finalizing")
	})

	it("keeps the exact legacy notification sequence on non-TUI surfaces", () => {
		const ctx = commandContext()
		ctx.mode = "rpc"
		const { api, sendMessage } = createExtensionApi()
		const report = reporter(ctx, true, api)
		const selection = selected({ lenses: ["spec"], concurrency: 1 })
		report.scope(target(), "/private/review/run")
		report.selection(selection)
		report.result(result(selection))
		expect(vi.mocked(ctx.ui.notify).mock.calls.map(([message]) => message)).toEqual([
			`Review scope pinned:\n${BASE_SHA}..${HEAD_SHA}\nCheckout: ${target().scope.checkoutPath}\nRun directory: /private/review/run`,
			"Review lenses:\nspec (Selected with --lens.)\nEffective concurrency: 1",
			"Review complete: 1 final finding.\nComplete review coverage.\nP2 src/value.ts:2 The new export lacks a behavior guard\nReport: /private/review/output/summary/final.json",
		])
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
			"review-panel",
			["Review complete: 1 final finding.", "Complete review coverage."],
			{ placement: "aboveEditor" },
		)
		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("uses the legacy string-array widget for a non-TUI error", () => {
		const ctx = commandContext()
		ctx.mode = "rpc"
		const { api } = createExtensionApi()
		const report = reporter(ctx, true, api)
		report.scope(target())
		report.selection(selected({ lenses: ["spec"], concurrency: 1 }))
		report.progress(progress(selected({ lenses: ["spec"] })))
		report.error(new Error("panel exploded"))
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
			"review-panel",
			["Review branch; 3 changed files", "Lenses: 1; concurrency 1", "Review failed: panel exploded"],
			{ placement: "aboveEditor" },
		)
	})
})
