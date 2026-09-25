import { initTheme, type Theme } from "@earendil-works/pi-coding-agent"
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { beforeAll, describe, expect, it } from "vitest"
import { createToolRenderContext } from "../__mocks__/tool-render-context.js"
import { bashStatus, renderBashCall, renderBashResult, safeBashText } from "./bash-display.js"
import type { ProcessDisplaySnapshot } from "./process-registry.js"

const display: ProcessDisplaySnapshot = {
	handle: "c1",
	command: "cat <<'EOF'\nhello 🌸 世界\nEOF",
	cwd: "/tmp",
	description: "Checking output",
	startedAt: 1000,
	observedAt: 43000,
	deadlineMs: 121000,
	state: "running",
	exitCode: null,
	reason: null,
	lastOutputAt: 42000,
	output: "first\nsecond\nthird\nfourth",
	outputBytes: 24,
	omittedBytes: 0,
}

const theme = {} as Theme
beforeAll(() => initTheme("default"))
describe("Bash display", () => {
	it("preserves all ordinary expanded output and its full-output path", () => {
		const output = Array.from({ length: 100 }, (_, index) => `ordinary line ${index}`).join("\n")
		const rendered = renderBashResult(
			{ content: [{ type: "text", text: output }], details: { fullOutputPath: "/tmp/ordinary-output.log" } },
			{ expanded: true, isPartial: false },
			theme,
			createToolRenderContext(),
		)
			.render(100)
			.map((line) => stripTerminalSequences(line).trimEnd())
			.join("\n")
		expect(rendered).toContain("ordinary line 0\n")
		expect(rendered).toContain("ordinary line 99")
		expect(rendered).toContain("Full output: /tmp/ordinary-output.log")
	})
	it("shows managed terminal result content and spill path after registry removal", () => {
		const output = Array.from({ length: 100 }, (_, index) => `terminal line ${index}`).join("\n")
		const rendered = renderBashResult(
			{
				content: [{ type: "text", text: output }],
				details: {
					display: { ...display, state: "exited", exitCode: 0, omittedBytes: 4000 },
					fullOutputPath: "/tmp/managed-output.log",
					truncation: { truncated: true, truncatedBy: "lines", outputLines: 100, totalLines: 1000 },
				},
			},
			{ expanded: true, isPartial: false },
			theme,
			createToolRenderContext(),
		)
			.render(100)
			.map((line) => stripTerminalSequences(line).trimEnd())
			.join("\n")
		expect(rendered).toContain("terminal line 0\n")
		expect(rendered).toContain("terminal line 99")
		expect(rendered).toContain("Full output: /tmp/managed-output.log")
		expect(rendered).toContain("Truncated")
		expect(rendered).not.toContain("/commands to inspect")
	})
	it("shows same process age, purpose, actual script and recent output during control waits", () => {
		const ctx = createToolRenderContext({ args: { handle: "c1" }, isPartial: true })
		const rendered = renderBashResult(
			{ content: [], details: { display } },
			{ expanded: false, isPartial: true },
			theme,
			ctx,
		)
			.render(100)
			.join("\n")
		expect(rendered).toContain("Checking output · Running · 42s")
		expect(rendered).toContain("cat <<'EOF'")
		expect(rendered).toContain("fourth")
		expect(rendered).not.toContain("first")
		expect(rendered).toContain("Last output 1s ago")
	})
	it("marks persisted running check-ins as captured state with frozen elapsed time", () => {
		const ctx = createToolRenderContext()
		const rendered = renderBashResult(
			{ content: [], details: { display } },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		)
			.render(100)
			.join("\n")
		expect(rendered).toContain("Still running at check-in · 42s")
		expect(rendered).toContain("Snapshot at check-in")
	})
	it("expansion preserves multiline script and shows a larger output tail", () => {
		const ctx = createToolRenderContext({ args: { command: display.command }, expanded: true })
		expect(renderBashCall(ctx.args, theme, ctx).render(100).join("\n")).toContain(display.command)
		const rendered = renderBashResult(
			{ content: [], details: { display } },
			{ expanded: true, isPartial: false },
			theme,
			ctx,
		)
			.render(100)
			.join("\n")
		expect(rendered).toContain("first")
	})
	it.each([1, 2, 7, 20, 80])("keeps hostile and Unicode output within %s terminal cells", (width) => {
		const hostile = "🌸 世界\x1b]52;c;c2VjcmV0\x07\x1b[31mred\x1b[0m\x08\x00\u202e"
		const result = renderBashResult(
			{ content: [], details: { display: { ...display, output: hostile } } },
			{ expanded: true, isPartial: true },
			theme,
			createToolRenderContext(),
		)
		for (const line of result.render(width)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width)
			expect(stripTerminalSequences(line)).not.toMatch(/[\p{Cc}\u202e]/u)
		}
		expect(safeBashText(hostile)).toBe("🌸 世界red")
	})
	it("distinguishes terminal outcomes without inventing success for missing exit status", () => {
		expect(bashStatus({ ...display, state: "exited", exitCode: 0, finishedAt: 4000 })).toBe("Exited 0 · 3s")
		expect(bashStatus({ ...display, state: "exited", exitCode: 7 })).toContain("Failed (exit 7)")
		expect(bashStatus({ ...display, state: "stopped", reason: "deadline" })).toContain("Deadline reached")
		expect(bashStatus({ ...display, state: "stopped", reason: "stop" })).toContain("Stopped")
		expect(bashStatus({ ...display, state: "exited", exitCode: null })).toContain("Outcome unavailable")
	})
})
