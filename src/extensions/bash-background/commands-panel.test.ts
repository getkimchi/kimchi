import type { BashOperations } from "@earendil-works/pi-coding-agent"
import {
	CURSOR_MARKER,
	ProcessTerminal,
	stripTerminalSequences,
	TuiAltScreen,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { testTheme } from "../__mocks__/theme.js"
import { isRawInputCaptureActive } from "../shared-input.js"
import { CommandsPanel } from "./commands-panel.js"
import { createProcessRegistry, type ProcessRegistry } from "./process-registry.js"

function start(registry: ProcessRegistry, command: string, description?: string) {
	let output: ((data: Buffer) => void) | undefined
	let finish: ((result: { exitCode: number | null }) => void) | undefined
	const operations: BashOperations = {
		exec: (_command, _cwd, options) =>
			new Promise((resolve) => {
				output = options.onData
				finish = resolve
				options.signal?.addEventListener("abort", () => resolve({ exitCode: null }), { once: true })
			}),
	}
	const handle = registry.spawn(operations, command, "/tmp", undefined, {
		description,
		limitSeconds: 120,
	})
	return {
		handle,
		output: (text: string) => output?.(Buffer.from(text)),
		finish: async () => {
			finish?.({ exitCode: 0 })
			await registry.whenExited(handle)
		},
	}
}

let registry: ProcessRegistry
let panel: CommandsPanel
const tui = { requestRender: vi.fn(), terminal: { rows: 18 } }
const view = () => panel.render(100).map(stripTerminalSequences).join("\n")
const mouse = (type: TuiMouseEvent["type"], x: number, y: number): TuiMouseEvent => ({
	type,
	button: "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width: 100,
	height: 18,
	shift: false,
	alt: false,
	ctrl: false,
})
beforeEach(() => {
	vi.useFakeTimers()
	registry = createProcessRegistry()
	tui.terminal.rows = 18
	tui.requestRender.mockClear()
})
afterEach(async () => {
	panel?.dispose()
	await registry.shutdown()
	vi.useRealTimers()
})
describe("CommandsPanel", () => {
	it("renders an open menu with room for the conversation and navigation", () => {
		start(registry, Array.from({ length: 80 }, (_, i) => `script ${i}`).join("\n"))
		panel = new CommandsPanel(registry, tui, vi.fn(), testTheme)
		for (const [width, rows] of [
			[135, 45],
			[90, 30],
			[72, 24],
			[40, 16],
		]) {
			tui.terminal.rows = rows
			for (const input of ["", "\r", "\t"]) {
				panel.handleInput(input)
				const lines = panel.render(width).map(stripTerminalSequences)
				expect(lines[0]).toMatch(/^─+$/)
				expect(lines.at(-1)).toMatch(/^─+$/)
				expect(lines.join("\n")).not.toMatch(/[╭╮╰╯│]/)
				expect(lines.join("\n")).toContain("Esc")
				for (const line of lines) expect(visibleWidth(line)).toBe(width)
				expect(lines.length).toBe(input === "" ? 5 : Math.max(9, Math.floor(rows / 2)))
			}
			panel.handleInput("\x1b")
		}
	})
	it("keeps the list compact and sizes detail from its content when entered", async () => {
		tui.terminal.rows = 60
		const process = start(registry, "printf short")
		panel = new CommandsPanel(registry, tui, vi.fn(), testTheme)
		expect(panel.render(100)).toHaveLength(5)
		panel.handleInput("\r")
		expect(panel.render(100)).toHaveLength(9)
		process.output("line\n".repeat(12))
		await vi.advanceTimersByTimeAsync(250)
		expect(panel.render(100)).toHaveLength(9)
		panel.handleInput("\x1b")
		expect(panel.render(100)).toHaveLength(5)
		panel.handleInput("\r")
		expect(panel.render(100)).toHaveLength(19)
		process.output("line\n".repeat(100))
		await vi.advanceTimersByTimeAsync(250)
		expect(panel.render(100)).toHaveLength(19)
		panel.handleInput("\x1b")
		panel.handleInput("\r")
		expect(panel.render(100)).toHaveLength(30)
	})
	it("sizes the list by command count without reserving space for hidden output", () => {
		tui.terminal.rows = 60
		for (let i = 0; i < 6; i++) start(registry, `echo ${i}`).output("line\n".repeat(100))
		panel = new CommandsPanel(registry, tui, vi.fn(), testTheme)
		expect(panel.render(100)).toHaveLength(10)
	})
	it("grows an initially empty list as commands start, up to the viewport cap", async () => {
		tui.terminal.rows = 20
		panel = new CommandsPanel(registry, tui, vi.fn(), testTheme)
		expect(panel.render(100)).toHaveLength(5)
		for (let i = 0; i < 3; i++) start(registry, `script-${i}`, `Worker ${i}`)
		await vi.advanceTimersByTimeAsync(250)
		expect(panel.render(100)).toHaveLength(7)
		for (let i = 0; i < 3; i++) expect(view()).toContain(`Worker ${i}`)
		expect(view()).not.toContain("script-")
		for (let i = 3; i < 12; i++) start(registry, `script-${i}`, `Worker ${i}`)
		await vi.advanceTimersByTimeAsync(250)
		expect(panel.render(100)).toHaveLength(10)
		for (let i = 0; i < 11; i++) panel.handleInput("\x1b[B")
		expect(view()).toContain("Worker 11")
	})
	it("opens the clicked visible row and switches tabs without changing the process", () => {
		for (let i = 0; i < 8; i++) start(registry, `script-${i}`, `Worker ${i}`).output(`output-${i}`)
		panel = new CommandsPanel(registry, tui, vi.fn(), testTheme)
		for (let i = 0; i < 7; i++) panel.handleInput("\x1b[B")
		view()
		expect(panel.handleMouse(mouse("press", 3, 2))).toEqual({ handled: true })
		panel.handleMouse(mouse("click", 3, 2))
		expect(view()).toContain("script-3")
		expect(view()).toContain("[Script]")
		panel.handleMouse(mouse("click", 12, 3))
		expect(view()).toContain("[Output]")
		expect(view()).toContain("output-3")
		panel.handleMouse(mouse("click", 2, 3))
		expect(view()).toContain("[Script]")
		expect(view()).not.toContain("output-3")
		expect(registry.listDisplaySnapshots().every((entry) => entry.state === "running")).toBe(true)
		expect(panel.handleMouse(mouse("click", 1, 0))).toBeUndefined()
		panel.dispose()
		expect(panel.handleMouse(mouse("click", 12, 3))).toBeUndefined()
	})
	it("does not expose the main-screen positioning marker as a fullscreen cursor", () => {
		const fullscreen = new TuiAltScreen(new ProcessTerminal(), true)
		vi.spyOn(fullscreen, "requestRender").mockImplementation(() => {})
		const render = fullscreen.render
		panel = new CommandsPanel(registry, fullscreen, vi.fn(), testTheme)
		expect(panel.render(100).join("\n")).not.toContain(CURSOR_MARKER)
		expect(fullscreen.render).toBe(render)
	})
	it("returns to the list before closing through the host", () => {
		start(registry, "sleep 60")
		const done = vi.fn()
		panel = new CommandsPanel(registry, tui, done, testTheme)
		panel.handleInput("\r")
		panel.handleInput("\x1b")
		expect(view()).toContain("Enter inspect")
		expect(done).not.toHaveBeenCalled()
		panel.handleInput("\x1b")
		expect(done).toHaveBeenCalledOnce()
	})
	it("pins the tabs and footer as output grows and removes the final newline's phantom row", async () => {
		tui.terminal.rows = 30
		const process = start(registry, "printf short")
		panel = new CommandsPanel(registry, tui, vi.fn(), testTheme)
		panel.handleInput("\r")
		const positions = () => {
			const lines = panel.render(80).map(stripTerminalSequences)
			return [
				lines.length,
				lines.findIndex((line) => line.includes("Script")),
				lines.findIndex((line) => line.includes("Lines ")),
				lines.findIndex((line) => line.includes("Esc back")),
			]
		}
		const script = positions()
		panel.handleInput("\t")
		process.output("one\ntwo\n")
		await vi.advanceTimersByTimeAsync(250)
		expect(positions()).toEqual(script)
		expect(view()).toContain("Lines 1–2 of 2")
		process.output("many lines\n".repeat(1000))
		await vi.advanceTimersByTimeAsync(250)
		expect(positions()).toEqual(script)
		expect(panel.render(45).map(stripTerminalSequences).join("\n")).toContain("older output omitted")
	})
	it("keeps status visible when a command title is wider than the menu", async () => {
		const process = start(registry, "a".repeat(120))
		panel = new CommandsPanel(registry, tui, vi.fn(), testTheme)
		await process.finish()
		await vi.advanceTimersByTimeAsync(250)
		for (const input of ["", "\r"]) {
			panel.handleInput(input)
			expect(panel.render(45).map(stripTerminalSequences).join("\n")).toContain("Exited 0")
		}
	})
	it("uses current page geometry before the first detail render and after resize", () => {
		start(registry, Array.from({ length: 80 }, (_, i) => `script ${i}`).join("\n"))
		panel = new CommandsPanel(registry, tui, vi.fn(), testTheme)
		view()
		panel.handleInput("\r")
		panel.handleInput("\x1b[6~")
		expect(view()).toContain("Lines 3–4 of 80")
		tui.terminal.rows = 28
		panel.handleInput("\x1b[6~")
		expect(view()).toContain("Lines 10–16 of 80")
	})
	it("pages up from the output tail before the first output render", () => {
		const process = start(registry, "echo output")
		process.output(Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n"))
		panel = new CommandsPanel(registry, tui, vi.fn(), testTheme)
		view()
		panel.handleInput("\r")
		panel.handleInput("\t")
		panel.handleInput("\x1b[5~")
		expect(view()).toContain("Lines 77–78 of 80")
	})
	it("explains empty session without changing process state", () => {
		panel = new CommandsPanel(registry, tui, vi.fn(), testTheme)
		expect(view()).toContain("No managed Bash commands running in this session")
	})
	it("keeps selected identity while another command disappears and retains its terminal result", async () => {
		const first = start(registry, "echo first"),
			second = start(registry, "echo second")
		panel = new CommandsPanel(registry, tui, vi.fn(), testTheme)
		panel.handleInput("\x1b[B")
		await first.finish()
		await registry.remove(first.handle)
		await vi.advanceTimersByTimeAsync(250)
		panel.handleInput("\r")
		expect(view()).toContain(`Command ${second.handle}`)
		second.output("final output")
		await second.finish()
		await registry.remove(second.handle)
		await vi.advanceTimersByTimeAsync(250)
		panel.handleInput("\t")
		expect(view()).toContain("Exited 0")
		expect(view()).toContain("final output")
	})
	it("preserves full multiline script, pauses scroll position, and End follows new output", async () => {
		tui.terminal.rows = 24
		const command = "cat <<'EOF'\nhello 字 世界\nEOF"
		const process = start(registry, command)
		process.output(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"))
		panel = new CommandsPanel(registry, tui, vi.fn(), testTheme)
		panel.handleInput("\r")
		for (const line of command.split("\n")) expect(view()).toContain(line)
		panel.handleInput("\t")
		expect(view()).toContain("line 29")
		panel.handleInput("\x1b[5~")
		const paused = view()
		expect(paused).toContain("Follow: off")
		process.output("\nnew latest")
		await vi.advanceTimersByTimeAsync(250)
		expect(view()).not.toContain("new latest")
		panel.handleInput("\x1b[F")
		expect(view()).toContain("new latest")
		expect(view()).toContain("Follow: on")
	})
	it("closes without aborting, removes its observer/timer and leaves deadline untouched", async () => {
		const process = start(registry, "sleep 60")
		const before = registry.displaySnapshot(process.handle)
		const unsubscribe = vi.fn()
		const original = registry.observeDisplay.bind(registry)
		vi.spyOn(registry, "observeDisplay").mockImplementation((...args) => {
			const off = original(...args)
			return () => {
				off()
				unsubscribe()
			}
		})
		const done = vi.fn()
		panel = new CommandsPanel(registry, tui, done, testTheme)
		expect(isRawInputCaptureActive()).toBe(true)
		panel.handleInput("\r")
		panel.handleInput("\t")
		panel.handleInput("\x1b")
		panel.handleInput("\x1b")
		expect(done).toHaveBeenCalledOnce()
		expect(isRawInputCaptureActive()).toBe(false)
		expect(unsubscribe).toHaveBeenCalledOnce()
		tui.requestRender.mockClear()
		await vi.advanceTimersByTimeAsync(1000)
		expect(tui.requestRender).not.toHaveBeenCalled()
		const after = registry.displaySnapshot(process.handle)
		expect(after?.state).toBe("running")
		expect(after?.deadlineMs).toBe(before?.deadlineMs)
	})
	it("safely wraps Unicode and controls through narrow resize", () => {
		const process = start(registry, "printf '字 世界'\nsecond line")
		process.output("\x1b]52;c;secret\x07\x1b[31m字 世界\x1b[0m\b\0")
		panel = new CommandsPanel(registry, tui, vi.fn(), testTheme)
		panel.handleInput("\r")
		panel.handleInput("\t")
		for (const width of [1, 2, 7, 20, 100])
			for (const rows of [3, 10, 25]) {
				tui.terminal.rows = rows
				const lines = panel.render(width)
				expect(lines.length).toBeLessThanOrEqual(Math.max(1, rows - 2))
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width)
					expect(stripTerminalSequences(line)).not.toMatch(/\p{Cc}/u)
				}
			}
	})
})
