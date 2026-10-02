import { initTheme } from "@earendil-works/pi-coding-agent"
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { testTheme as theme } from "../__mocks__/theme.js"
import { createToolRenderContext } from "../__mocks__/tool-render-context.js"
import { bashStatus, bashStatusColor, renderBashCall, renderBashResult, safeBashText } from "./bash-display.js"
import { createProcessRegistry, type ProcessDisplaySnapshot } from "./process-registry.js"
import { getSessionRegistry, setSessionRegistry } from "./session-registry.js"

const display: ProcessDisplaySnapshot = {
	handle: "c1",
	command: "cat <<'EOF'\nhello 字 世界\nEOF",
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

beforeAll(() => initTheme("default"))
afterEach(async () => {
	await getSessionRegistry()?.shutdown()
	setSessionRegistry(undefined)
})
describe("Bash display", () => {
	it.each([false, true])("shows one native-style title across the combined card (expanded: %s)", (expanded) => {
		const ctx = createToolRenderContext({
			args: { command: display.command, description: display.description },
			expanded,
		})
		const call = renderBashCall(ctx.args, theme, ctx)
		const result = renderBashResult({ content: [], details: { display } }, { expanded, isPartial: true }, theme, ctx)
		const lines = [...call.render(100), ...result.render(100)].map(stripTerminalSequences)
		const text = lines.join("\n")
		expect(text.match(/Checking output/g)).toHaveLength(1)
		expect(lines[0]).toMatch(/^[●◐◓◑◒] Bash Checking output/)
		expect(text).toContain("└─ Running · 42s")
		expect(text).toContain("fourth")
		if (expanded) {
			expect(text).toContain("cat <<'EOF'")
			expect(text).toContain("hello 字 世界")
			expect(text).toContain("Command c1")
			expect(text).toContain("Last output 1s ago")
		} else {
			expect(text).not.toContain("cat <<")
			expect(text).not.toContain("Command c1")
			expect(text).not.toContain("Last output")
			expect(text).toContain("Older output omitted · /processes to inspect")
		}
	})

	it.each([0, 7])("keeps the final title once and reflects exit %s in the original header", (exitCode) => {
		const ctx = createToolRenderContext({ args: { command: "printf hello", description: "Checking output" } })
		const call = renderBashCall(ctx.args, theme, ctx)
		const result = renderBashResult(
			{ content: [{ type: "text", text: "hello" }], details: { display: { ...display, state: "exited", exitCode } } },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		)
		const header = call.render(100).join("\n")
		const text = [header, ...result.render(100)].map(stripTerminalSequences).join("\n")
		expect(text.match(/Checking output/g)).toHaveLength(1)
		expect(header).toContain(theme.fg(exitCode === 0 ? "success" : "error", "●"))
		expect(text).toContain(exitCode === 0 ? "└─ Exited 0" : "└─ Failed (exit 7)")
		expect(text).toContain("hello")
		expect(text).not.toContain("Command c1")
	})

	it("uses the command as the header when no description is provided", () => {
		const command = "printf hello"
		const ctx = createToolRenderContext({ args: { command } })
		const call = renderBashCall(ctx.args, theme, ctx)
		const result = renderBashResult(
			{ content: [], details: { display: { ...display, command, description: undefined, output: "" } } },
			{ expanded: false, isPartial: true },
			theme,
			ctx,
		)
		const lines = [...call.render(100), ...result.render(100)].map(stripTerminalSequences)
		expect(lines[0]).toContain("Bash printf hello")
		expect(lines.join("\n").match(/printf hello/g)).toHaveLength(1)
		expect(lines.join("\n")).toContain("No output yet")
	})

	it("bounds a collapsed script without a description and preserves it on expansion", () => {
		const command = `python3 - <<'END'\n${"print('long script')\n".repeat(100)}END`
		const ctx = createToolRenderContext({ args: { command } })
		const call = renderBashCall(ctx.args, theme, ctx)
		expect(call.render(60).length).toBeLessThanOrEqual(2)
		expect(call.render(60).map(stripTerminalSequences).join("\n")).toContain("…")
		ctx.expanded = true
		expect(
			call
				.render(60)
				.map(stripTerminalSequences)
				.join("\n")
				.match(/print\('long script'\)/g),
		).toHaveLength(100)
	})

	it("folds repeated historical check-ins into the original row, retaining final expansion and errors", () => {
		setSessionRegistry(createProcessRegistry())
		const initial = { content: [], details: { display } }
		const options = { expanded: true, isPartial: false }
		const ctx = createToolRenderContext({ args: { command: display.command } })
		let original: ReturnType<typeof renderBashResult>
		ctx.invalidate = () => {
			original = renderBashResult({ ...initial }, options, theme, ctx)
		}
		original = renderBashResult(initial, options, theme, ctx)
		const control = createToolRenderContext({ args: { handle: display.handle } })
		const call = renderBashCall(control.args, theme, control)
		expect(call.render(100)).toEqual([])
		const checkins = ["second check-in", "third check-in"].map((output) => ({
			ctx: createToolRenderContext({ args: { handle: display.handle } }),
			result: { content: [], details: { display: { ...display, output } } },
		}))
		for (const checkin of checkins) {
			const result = renderBashResult(checkin.result, options, theme, checkin.ctx)
			expect(result.render(100)).toEqual([])
			expect(original.render(100).join("\n")).toContain(checkin.result.details.display.output)
		}
		const output = Array.from({ length: 100 }, (_, index) => `final line ${index}`).join("\n")
		renderBashResult(
			{
				content: [{ type: "text", text: output }],
				details: { display: { ...display, state: "exited", exitCode: 7 }, fullOutputPath: "/tmp/final.log" },
			},
			options,
			theme,
			control,
		)
		const final = original.render(100).map(stripTerminalSequences).join("\n")
		expect(final).toContain("final line 0")
		expect(final).toContain("final line 99")
		expect(final).toContain("Failed (exit 7)")
		expect(final).toContain("Full output: /tmp/final.log")
		// Expanding old tool calls must not replay an earlier check-in over the final result.
		for (const checkin of checkins) renderBashResult({ ...checkin.result }, options, theme, checkin.ctx)
		ctx.invalidate()
		expect(original.render(100).map(stripTerminalSequences).join("\n")).toBe(final)
		const error = renderBashResult(
			{ content: [{ type: "text", text: "Error: unknown handle" }], details: {} },
			options,
			theme,
			control,
		)
		expect(call.render(100).join("\n")).toContain("Bash")
		expect(error.render(100).join("\n")).toContain("Error: unknown handle")
		setSessionRegistry(createProcessRegistry())
		expect(renderBashCall(control.args, theme, control).render(100).join("\n")).toContain("Bash")
	})

	it("keeps the original card live between check-ins and preserves settlement after removal", async () => {
		const registry = createProcessRegistry()
		setSessionRegistry(registry)
		let emit!: (data: Buffer) => void
		let exit!: (result: { exitCode: number }) => void
		const handle = registry.spawn(
			{
				exec: async (_command, _cwd, { onData, signal }) => {
					emit = onData
					return new Promise((resolve) => {
						exit = resolve
						signal?.addEventListener("abort", () => resolve({ exitCode: null }), { once: true })
					})
				},
			},
			"demo",
			"/tmp",
			undefined,
			{ intervalSeconds: 15, deadlineMs: Date.now() + 60000 },
		)
		const initial = { content: [], details: { display: registry.displaySnapshot(handle) } }
		const options = { expanded: true, isPartial: false }
		const ctx = createToolRenderContext({ args: { command: "demo" } })
		let original: ReturnType<typeof renderBashResult>
		ctx.invalidate = vi.fn(() => {
			original = renderBashResult({ ...initial }, options, theme, ctx)
		})
		original = renderBashResult(initial, options, theme, ctx)
		emit(Buffer.from("output between check-ins\n"))
		expect(original.render(100).join("\n")).toContain("output between check-ins")
		expect(original.render(100).join("\n")).not.toContain("Snapshot at check-in")
		exit({ exitCode: 0 })
		await registry.whenExited(handle)
		await registry.remove(handle)
		expect(original.render(100).join("\n")).toContain("Exited 0")
		expect(original.render(100).join("\n")).toContain("output between check-ins")
		expect(ctx.invalidate).toHaveBeenCalled()
	})
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
		expect(rendered).not.toContain("/processes to inspect")
	})
	it("shows one purpose and recent output for an unlinked control", () => {
		const ctx = createToolRenderContext({ args: { handle: "c1" }, isPartial: true })
		const call = renderBashCall(ctx.args, theme, ctx)
		const result = renderBashResult(
			{ content: [], details: { display } },
			{ expanded: false, isPartial: true },
			theme,
			ctx,
		)
		const lines = [...call.render(100), ...result.render(100)]
		expect(lines.join("\n")).toContain(theme.fg("accent", "/processes"))
		const rendered = lines.map(stripTerminalSequences).join("\n")
		expect(rendered.match(/Checking output/g)).toHaveLength(1)
		expect(rendered).toContain("└─ Running · 42s")
		expect(rendered).not.toContain("cat <<'EOF'")
		expect(rendered).toContain("fourth")
		expect(rendered).not.toContain("first")
		expect(rendered).not.toContain("Last output 1s ago")
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
			.map(stripTerminalSequences)
			.join("\n")
		expect(rendered).toContain("Still running at check-in · 42s")
		expect(rendered.match(/check-in/g)).toHaveLength(1)
	})
	it("expansion preserves multiline script and shows a larger output tail", () => {
		const ctx = createToolRenderContext({ args: { command: display.command }, expanded: true })
		const script = renderBashCall(ctx.args, theme, ctx).render(100).map(stripTerminalSequences).join("\n")
		for (const line of display.command.split("\n")) expect(script).toContain(line)
		const rendered = renderBashResult(
			{ content: [], details: { display } },
			{ expanded: true, isPartial: false },
			theme,
			ctx,
		)
			.render(100)
			.map(stripTerminalSequences)
			.join("\n")
		expect(rendered).toContain("first")
	})
	it.each([1, 2, 7, 20, 80])("keeps hostile and Unicode output within %s terminal cells", (width) => {
		const hostile = "字 世界\x1b]52;c;c2VjcmV0\x07\x1b[31mred\x1b[0m\x08\x00\u202e"
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
		expect(safeBashText(hostile)).toBe("字 世界red")
	})
	it("distinguishes terminal outcomes without inventing success for missing exit status", () => {
		expect(bashStatusColor(display)).toBe("accent")
		expect(bashStatusColor({ ...display, state: "exited", exitCode: 0 })).toBe("success")
		expect(bashStatusColor({ ...display, state: "exited", exitCode: 7 })).toBe("error")
		expect(bashStatusColor({ ...display, state: "stopped", reason: "deadline" })).toBe("warning")
		expect(bashStatus({ ...display, state: "exited", exitCode: 0, finishedAt: 4000 })).toBe("Exited 0 · 3s")
		expect(bashStatus({ ...display, state: "exited", exitCode: 7 })).toContain("Failed (exit 7)")
		expect(bashStatus({ ...display, state: "stopped", reason: "deadline" })).toContain("Deadline reached")
		expect(bashStatus({ ...display, state: "stopped", reason: "stop" })).toContain("Stopped")
		expect(bashStatus({ ...display, state: "exited", exitCode: null })).toContain("Outcome unavailable")
	})
})
