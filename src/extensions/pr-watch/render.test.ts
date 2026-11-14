import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { lightTestTheme, testTheme } from "../__mocks__/theme.js"
import { createToolRenderContext } from "../__mocks__/tool-render-context.js"
import { formatPRWatchStatus } from "./presentation.js"
import { renderPRWatchCall, renderPRWatchResult } from "./render.js"
import type { PRCheck, PRWatchState, TargetState } from "./types.js"
import { renderPRWatchWidget } from "./widget.js"

const target = (number: number, overrides: Partial<TargetState> = {}, checks: PRCheck["state"][] = ["passed"]) =>
	({
		url: `https://github.com/owner/repo/pull/${number}`,
		cwd: `/checkouts/${number}`,
		enabled: true,
		autoFix: true,
		mode: "ci",
		instructions: "",
		attempts: 0,
		handled: [],
		phase: "watching",
		checkedAt: null,
		message: null,
		pullRequest: {
			provider: "github",
			repository: "owner/repo",
			number,
			title: "Fix the parser",
			url: `https://github.com/owner/repo/pull/${number}`,
			branch: "fix",
			headSha: "a".repeat(40),
			state: "open",
			checks: checks.map((state, i) => ({ id: String(i), name: `check-${i}`, state, url: null, summary: "" })),
			feedback: [],
		},
		...overrides,
	}) satisfies TargetState
const watching = (...targets: TargetState[]): PRWatchState => ({ targets, message: null })
const BRANCHES = ["└─ ", "   "]
/** Rendered lines without styling, padding or the transcript's branch prefix. */
const plain = (lines: string[]) =>
	lines
		.map((rendered) => {
			const line = stripTerminalSequences(rendered).trimEnd()
			return BRANCHES.some((branch) => line.startsWith(branch)) ? line.slice(3) : line
		})
		.join("\n")
const card = (state: PRWatchState | undefined, options = { expanded: false, isPartial: false }, isError = false) =>
	plain(
		renderPRWatchResult(
			{
				content: [{ type: "text", text: "Full status\nsecond line" }],
				details: state ? { state } : undefined,
			} as never,
			options,
			testTheme,
			createToolRenderContext({ isError }),
		).render(110),
	)
const widget = (state: PRWatchState, width = 150) => plain(renderPRWatchWidget(state, width, testTheme))

describe("PR watch chat card", () => {
	it("summarizes one PR or a set, and shows what needs attention", () => {
		expect(card(watching(target(7)))).toContain(
			"PR #7 · Watching · Auto-fix on · CI only\nCI: 1 passed · Review threads 0",
		)
		const dirty = target(7, { phase: "attention", message: "Commit or stash local changes" })
		expect(card(watching(dirty))).toContain("PR #7 · Needs attention · Auto-fix on · CI only")
		expect(card(watching(dirty))).toContain("Commit or stash local changes")
		expect(card(watching(dirty, target(8, {}, ["failed"])))).toContain(
			"2 PRs · 1 need attention · Auto-fix on\nCI failing on 1 · Review threads 0",
		)
	})

	it("strips terminal controls from a request error shown without a watched PR", () => {
		const state = { targets: [], message: "https://x\u001b]52;c;secret\u0007: Use a GitHub PR URL." }
		const raw = renderPRWatchResult(
			{ content: [{ type: "text", text: "PR watch · Not watching" }], details: { state } },
			{ expanded: false, isPartial: false },
			testTheme,
			createToolRenderContext(),
		)
			.render(110)
			.join("\n")
		expect(raw).toContain("https://x: Use a GitHub PR URL.")
		expect(raw).not.toContain("secret")
	})

	it("keeps errors, progress and the full output available", () => {
		expect(card(undefined, undefined, true)).toContain("Full status · ctrl+o for details")
		expect(card(watching(target(7)), { expanded: false, isPartial: true })).toContain("Checking PR…")
		expect(card(watching(target(7)), { expanded: true, isPartial: false })).toContain("Full status\nsecond line")
	})

	it.each([testTheme, lightTestTheme])("shows raw URLs and instructions only when expanded", (theme) => {
		const args = { url: "https://github.com/owner/repo/pull/7", instructions: "only fix \x1b[31mlint" }
		const call = (expanded: boolean) =>
			plain(renderPRWatchCall(args, theme, createToolRenderContext({ expanded })).render(80))
		expect(call(false)).toBe("PR watch · Start watching")
		expect(call(true)).toContain("https://github.com/owner/repo/pull/7\nonly fix lint")
	})
})

describe("PR watch row", () => {
	it("hides with nothing watched and links to the Monitor otherwise", () => {
		expect(widget(watching(target(7, { enabled: false })))).toBe("")
		expect(widget(watching(target(7, { phase: "error", message: "rate limit" }, [])))).toBe(
			"PR #7: Unavailable · rate limit · /pr-watch monitor",
		)
		expect(widget(watching(target(7), target(8, { phase: "fixing" })))).toContain(
			"2 PRs: Fixing owner/repo PR #8 · CI failing on 0",
		)
	})

	it("fits narrow terminals", () => {
		for (const width of [1, 20, 89]) {
			const [line] = renderPRWatchWidget(watching(target(7)), width, testTheme)
			expect(visibleWidth(line)).toBeLessThanOrEqual(width)
		}
		expect(widget(watching(target(7)), 60)).toBe("PR #7: Watching · /pr-watch monitor")
	})
})

describe("PR watch status text", () => {
	it("lists each PR with its checkout and the permissions fixes use", () => {
		const text = formatPRWatchStatus(
			watching(target(7), target(8, { enabled: false, autoFix: false, message: "PR merged. Monitoring stopped." })),
		)
		expect(text).toContain(
			"PR #7 Fix the parser\nhttps://github.com/owner/repo/pull/7\nWatching · Auto-fix on · CI only",
		)
		expect(text).toContain("Checkout: /checkouts/7")
		expect(text).toContain("Stopped · Auto-fix off")
		expect(text).toContain("PR merged. Monitoring stopped.")
		expect(text).toContain("Auto-fix may edit, test, commit and push under normal permissions")
		expect(formatPRWatchStatus(watching())).toBe("PR watch · Not watching")
	})
})
