/**
 * Narrow-terminal width-invariant fuzz for tool execution rendering.
 *
 * Renders the real ToolExecutionComponent for every built-in tool the
 * tool-rendering extension overrides — collapsed and expanded, call and
 * result phases — at widths 1..12 and asserts every emitted line fits the
 * terminal. pi-tui's doRender hard-crashes on the first over-wide line, so
 * any failure here is a production crash.
 */

import type { Theme } from "@earendil-works/pi-coding-agent"
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent"
import { type TUI, visibleWidth } from "@earendil-works/pi-tui"
import { beforeAll, describe, expect, it } from "vitest"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import toolRenderingExtension, { ToolText, toolHeader } from "./tool-rendering.js"

const plainTheme = {
	fg: (_name: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme

const fakeTui = { requestRender: () => {} } as unknown as TUI

function makeComponent(
	toolName: string,
	args: Record<string, unknown>,
	resultText: string | undefined,
	expanded: boolean,
): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		toolName,
		`tc-${toolName}-${expanded}`,
		args,
		{},
		undefined,
		fakeTui,
		"/tmp",
	)
	if (resultText !== undefined) {
		component.markExecutionStarted()
		component.updateResult({ content: [{ type: "text", text: resultText }], isError: false }, false)
	}
	component.setExpanded(expanded)
	return component
}

const LONG_OUTPUT = Array.from(
	{ length: 40 },
	(_, i) => `output line ${i} with some decently long content to force wrapping behavior`,
).join("\n")

const DIFF_EDIT_ARGS = {
	path: "/Users/someone/reps/project/src/file.ts",
	oldText: "const alpha = 1\nconst beta = 2\nconst gamma = 3",
	newText: "const alpha = 10\nconst beta = 2\nconst gamma = 30\nconst delta = 4",
}

const CASES: Array<{ name: string; args: Record<string, unknown>; result?: string }> = [
	{ name: "bash", args: { command: "pnpm run test -- --reporter=verbose" }, result: LONG_OUTPUT },
	{ name: "bash", args: { command: "pnpm run test" } },
	{ name: "read", args: { path: "/Users/someone/reps/project/src/file.ts" }, result: LONG_OUTPUT },
	{ name: "read", args: { path: "/Users/someone/reps/project/src/file.ts" } },
	{ name: "edit", args: DIFF_EDIT_ARGS, result: "Edit applied" },
	{ name: "edit", args: DIFF_EDIT_ARGS },
	{
		name: "write",
		args: { path: "/Users/someone/reps/project/src/new-file.ts", content: LONG_OUTPUT },
		result: "Written",
	},
	{ name: "grep", args: { pattern: "wrapMarkedLine", path: "/Users/someone/reps/project" }, result: LONG_OUTPUT },
	{ name: "find", args: { pattern: "*.ts", path: "/Users/someone/reps/project" }, result: LONG_OUTPUT },
	{
		name: "list",
		args: { path: "/Users/someone/reps/project/src/extensions/" },
		result: Array.from({ length: 20 }, (_, i) => `entry-${i}.ts`).join("\n"),
	},
	{ name: "unknown_tool", args: { foo: "bar" }, result: LONG_OUTPUT },
]

describe("tool execution narrow-terminal width invariant", () => {
	beforeAll(() => {
		initTheme("default")
		toolRenderingExtension(createExtensionApi().api)
	})

	// ToolText fuzz: headers with a WRAP_MARK-tagged long summary — the shape
	// that caused the (9 > 2) doRender crash (` ● Edit /Users/...`). This is
	// the direct contract the end-to-end cases above cannot reliably reach,
	// because whether a header carries a marked summary depends on each
	// tool's arg-shape heuristics.
	const CRASH_HEADERS = [
		// Exact shape from the reported pi-crash.log (leading space included).
		` ${toolHeader("Edit", "/Users/vytautaspetrikas/reps/very/long/path/file.ts", plainTheme, "● ")}`,
		toolHeader("Read", "/Users/someone/reps/project/src/deeply/nested/file.ts", plainTheme, "● "),
		toolHeader("Bash", "pnpm run test -- --reporter=verbose --runInBand --watchAll", plainTheme, "◎ "),
		toolHeader("Grep", "wrapMarkedLineWithSomeVeryLongPattern", plainTheme, "✗ ", "12.0s"),
	]

	it("ToolText never emits a line wider than the requested width", () => {
		for (const header of CRASH_HEADERS) {
			const component = new ToolText(header)
			for (let width = 1; width <= 12; width++) {
				for (const line of component.render(width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width)
				}
			}
		}
	})

	it("ToolText respects the width on cached re-renders across resizes", () => {
		const component = new ToolText(CRASH_HEADERS[0])
		for (const width of [80, 2, 1, 30, 80]) {
			component.invalidate()
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width)
			}
		}
	})

	for (const c of CASES) {
		for (const expanded of [false, true]) {
			it(`${c.name}${c.result ? " (result)" : " (call)"}${expanded ? " expanded" : " collapsed"} fits widths 1-12`, async () => {
				const component = makeComponent(c.name, c.args, c.result, expanded)
				// Some result renderers (edit diffs) resolve syntax highlighting async.
				await new Promise((resolve) => setTimeout(resolve, 50))
				for (let width = 1; width <= 12; width++) {
					const lines = component.render(width)
					for (const line of lines) {
						expect(visibleWidth(line)).toBeLessThanOrEqual(width)
					}
				}
			})
		}
	}
})
