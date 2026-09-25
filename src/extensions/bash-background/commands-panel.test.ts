import type { BashOperations } from "@earendil-works/pi-coding-agent"
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isRawInputCaptureActive } from "../shared-input.js"
import { CommandsPanel } from "./commands-panel.js"
import { createProcessRegistry, type ProcessRegistry } from "./process-registry.js"

function start(registry: ProcessRegistry, command: string) {
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
		intervalSeconds: 15,
		deadlineMs: Date.now() + 120000,
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
	it("frames and pads every row, keeping navigation visible in short terminals", () => {
		start(registry, Array.from({ length: 80 }, (_, i) => `script ${i}`).join("\n"))
		panel = new CommandsPanel(registry, tui, vi.fn())
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
				expect(lines[0]).toMatch(/^╭─+╮$/)
				expect(lines.at(-1)).toMatch(/^╰─+╯$/)
				expect(lines.join("\n")).toContain("Esc")
				for (const line of lines) expect(visibleWidth(line)).toBe(width)
				expect(lines.length).toBeLessThanOrEqual(rows - 2)
			}
			panel.handleInput("\x1b")
		}
	})
	it("uses current page geometry before the first detail render and after resize", () => {
		start(registry, Array.from({ length: 80 }, (_, i) => `script ${i}`).join("\n"))
		panel = new CommandsPanel(registry, tui, vi.fn())
		view()
		panel.handleInput("\r")
		panel.handleInput("\x1b[6~")
		expect(view()).toContain("Lines 9–16 of 80")
		tui.terminal.rows = 28
		panel.handleInput("\x1b[6~")
		expect(view()).toContain("Lines 27–44 of 80")
	})
	it("pages up from the output tail before the first output render", () => {
		const process = start(registry, "echo output")
		process.output(Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n"))
		panel = new CommandsPanel(registry, tui, vi.fn())
		view()
		panel.handleInput("\r")
		panel.handleInput("\t")
		panel.handleInput("\x1b[5~")
		expect(view()).toContain("Lines 65–72 of 80")
	})
	it("explains empty session without changing process state", () => {
		panel = new CommandsPanel(registry, tui, vi.fn())
		expect(view()).toContain("No managed Bash commands running in this session")
	})
	it("keeps selected identity while another command disappears and retains its terminal result", async () => {
		const first = start(registry, "echo first"),
			second = start(registry, "echo second")
		panel = new CommandsPanel(registry, tui, vi.fn())
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
		const command = "cat <<'EOF'\nhello 🌸 世界\nEOF"
		const process = start(registry, command)
		process.output(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"))
		panel = new CommandsPanel(registry, tui, vi.fn())
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
		panel = new CommandsPanel(registry, tui, done)
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
		const process = start(registry, "printf '🌸 世界'\nsecond line")
		process.output("\x1b]52;c;secret\x07\x1b[31m🌸 世界\x1b[0m\b\0")
		panel = new CommandsPanel(registry, tui, vi.fn())
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
