import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { lightTestTheme, testTheme } from "../__mocks__/theme.js"
import { createToolRenderContext } from "../__mocks__/tool-render-context.js"
import { renderPRWatchCall, renderPRWatchResult } from "./render.js"
import { PLAN_MODE_MESSAGE, type PRMonitorState, type PRSnapshot } from "./types.js"

const state: PRMonitorState & { pullRequest: PRSnapshot } = {
	revision: 1,
	enabled: true,
	autoFix: true,
	phase: "watching",
	checkedAt: null,
	message: null,
	pullRequest: {
		provider: "github",
		repository: "owner/repo",
		number: 7,
		title: "Fix the parser",
		url: "https://github.com/owner/repo/pull/7",
		branch: "fix/parser",
		headSha: "a".repeat(40),
		state: "open",
		checks: [{ id: "tests", name: "Tests", state: "passed", url: null, summary: "" }],
		feedback: [],
	},
}

const text = (view: ReturnType<typeof renderPRWatchResult>) => view.render(110).map(stripTerminalSequences).join("\n")
const result = (next: PRMonitorState = state, content = "Complete model-facing output") => ({
	content: [{ type: "text" as const, text: content }],
	details: { state: next },
})

describe("PR Watch chat card", () => {
	it("shows the PR and useful status instead of the output line count", () => {
		const rendered = text(
			renderPRWatchResult(result(), { expanded: false, isPartial: false }, testTheme, createToolRenderContext()),
		)
		expect(rendered).toContain("#7 · Watching · Auto-fix on")
		expect(rendered).toContain("CI: 1 passed · Review threads 0")
		expect(rendered).not.toContain("lines returned")
		expect(rendered).not.toContain(state.pullRequest?.url)
	})

	it("makes Plan's paused fixes explicit without claiming they are on", () => {
		const rendered = text(
			renderPRWatchResult(
				result({ ...state, message: PLAN_MODE_MESSAGE }),
				{ expanded: false, isPartial: false },
				testTheme,
				createToolRenderContext(),
			),
		)
		expect(rendered).toContain("Fixes paused in Plan")
		expect(rendered).not.toContain("Auto-fix on")
	})

	it("counts review threads independently of their author", () => {
		const feedback = ["one", "two"].map((id) => ({
			id,
			author: "same-reviewer",
			body: "Please add a test",
			url: "https://github.com/owner/repo/pull/7",
			path: "parser.ts",
			line: 8,
			trusted: true,
		}))
		const next = { ...state, pullRequest: { ...state.pullRequest, feedback } }
		const rendered = text(
			renderPRWatchResult(result(next), { expanded: false, isPartial: false }, testTheme, createToolRenderContext()),
		)
		expect(rendered).toContain("Review threads 2")
	})

	it("keeps unavailable, unknown and stopped CI distinct from healthy checks", () => {
		const empty = { ...state, pullRequest: { ...state.pullRequest, checks: [] } }
		const render = (next: PRMonitorState) =>
			text(
				renderPRWatchResult(result(next), { expanded: false, isPartial: false }, testTheme, createToolRenderContext()),
			)
		expect(render(empty)).toContain("CI unknown")
		expect(render({ ...empty, phase: "error" })).toContain("CI unavailable")
		expect(render({ ...state, enabled: false })).toContain("Stopped · Auto-fix off")
		expect(render({ ...state, enabled: false })).toContain("CI (last known): 1 passed")
	})

	it.each([testTheme, lightTestTheme])("preserves complete expanded output and safe narrow rendering", (theme) => {
		const output = `first\n${"details\n".repeat(80)}last\x1b]52;c;secret\x07\u202e`
		const view = renderPRWatchResult(
			result(state, output),
			{ expanded: true, isPartial: false },
			theme,
			createToolRenderContext(),
		)
		const rendered = text(view)
		expect(rendered).toContain("first")
		expect(rendered).toContain("last")
		expect(rendered.match(/details/g)).toHaveLength(80)
		expect(rendered).not.toContain("secret")
		for (const width of [1, 2, 20, 60, 110]) {
			for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
		}
	})

	it("keeps the failure reason visible and full errors available on expansion", () => {
		const failed = result(state, "GitHub login expired\nSign in again before watching.")
		const ctx = createToolRenderContext({ isError: true })
		expect(text(renderPRWatchResult(failed, { expanded: false, isPartial: false }, testTheme, ctx))).toContain(
			"GitHub login expired",
		)
		expect(text(renderPRWatchResult(failed, { expanded: true, isPartial: false }, testTheme, ctx))).toContain(
			"Sign in again",
		)
	})

	it("keeps raw URLs and instructions in the expanded call only", () => {
		const args = { url: state.pullRequest?.url, instructions: "Fix CI only\x1b]52;c;secret\x07" }
		const collapsed = renderPRWatchCall(args, testTheme, createToolRenderContext())
		const expanded = renderPRWatchCall(args, testTheme, createToolRenderContext({ expanded: true }))
		expect(text(collapsed)).toContain("PR watch · Start watching")
		expect(text(collapsed)).not.toContain("https://")
		expect(text(expanded)).toContain(state.pullRequest?.url)
		expect(text(expanded)).toContain("Fix CI only")
		expect(text(expanded)).not.toContain("secret")
	})
})
