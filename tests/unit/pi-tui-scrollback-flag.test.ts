import { TUI } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

/**
 * Regression test for the iTerm2 scroll-to-top bug.
 *
 * pi-tui's fullRender(true) emits ESC[2J (erase screen) + ESC[3J (erase
 * scrollback) + ESC[H (home cursor). On iTerm2, ESC[3J while the viewport is
 * scrolled up snaps the view to the start of the session. Our patch makes
 * ESC[3J conditional on the PI_TUI_NO_CLEAR_SCROLLBACK environment variable.
 *
 * This test exercises the patched pi-tui directly and asserts the presence or
 * absence of ESC[3J in the terminal output based on the flag.
 */

/**
 * Minimal fake terminal that satisfies the pi-tui Terminal interface.
 * We only need to capture everything written to stdout; input, resizing,
 * and cursor visibility methods are no-ops for this assertion.
 */
function makeMockTerminal(): {
	writes: string[]
	terminal: import("@earendil-works/pi-tui").Terminal
} {
	const writes: string[] = []
	return {
		writes,
		terminal: {
			start: vi.fn(),
			stop: vi.fn(),
			drainInput: vi.fn().mockResolvedValue(undefined),
			write: vi.fn((data: string) => writes.push(data)),
			columns: 80,
			rows: 24,
			kittyProtocolActive: false,
			moveBy: vi.fn(),
			hideCursor: vi.fn(),
			showCursor: vi.fn(),
			clearLine: vi.fn(),
			clearFromCursor: vi.fn(),
			clearScreen: vi.fn(),
			setTitle: vi.fn(),
			setProgress: vi.fn(),
		} as unknown as import("@earendil-works/pi-tui").Terminal,
	}
}

/** Wait long enough for requestRender(true) -> process.nextTick -> doRender. */
function flushRender(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Count how many rendered content lines (line-*) appear in the output. */
function countRenderedLines(output: string): number {
	return (output.match(/line-\d+/g) ?? []).length
}

beforeEach(() => {
	vi.stubEnv("PI_TUI_NO_CLEAR_SCROLLBACK", "1")
})

afterEach(() => {
	vi.unstubAllEnvs()
})

it("does not emit ESC[3J when PI_TUI_NO_CLEAR_SCROLLBACK=1", async () => {
	const { writes, terminal } = makeMockTerminal()
	const tui = new TUI(terminal, false)

	// Render enough lines to exceed the 24-row mock terminal so the render
	// path exercises scrolling and full redraw logic.
	tui.addChild({
		render: () => Array.from({ length: 50 }, (_, i) => `line-${i}`),
		invalidate: () => {},
	})

	// force=true clears previous state and triggers fullRender(true), the path
	// that normally emits ESC[3J.
	tui.requestRender(true)
	await flushRender()

	const output = writes.join("")
	expect(output).toContain("\x1b[2J")
	expect(output).toContain("\x1b[H")
	expect(output).not.toContain("\x1b[3J")
})

it("emits ESC[3J by default", async () => {
	// Unset the flag so the default (legacy) behavior is exercised.
	vi.stubEnv("PI_TUI_NO_CLEAR_SCROLLBACK", undefined)

	const { writes, terminal } = makeMockTerminal()
	const tui = new TUI(terminal, false)

	tui.addChild({
		render: () => Array.from({ length: 50 }, (_, i) => `line-${i}`),
		invalidate: () => {},
	})

	tui.requestRender(true)
	await flushRender()

	const output = writes.join("")
	expect(output).toContain("\x1b[2J")
	expect(output).toContain("\x1b[H")
	expect(output).toContain("\x1b[3J")
})

it("does not full-redraw when only scrollback content changes", async () => {
	const { writes, terminal } = makeMockTerminal()
	const tui = new TUI(terminal, false)

	let lines = Array.from({ length: 50 }, (_, i) => `line-${i}`)
	tui.addChild({
		render: () => lines,
		invalidate: () => {},
	})

	// Initial full render (force=true resets state and emits everything).
	tui.requestRender(true)
	await flushRender()

	const initialOutput = writes.join("")
	expect(initialOutput).toContain("\x1b[2J")
	expect(countRenderedLines(initialOutput)).toBe(50)

	// Simulate a change to a line that is now in scrollback (line 0), leaving
	// the visible viewport unchanged. Before the patch this triggered
	// fullRender(true) and re-emitted the whole transcript, duplicating
	// scrollback. Now it should update internal state without writing output.
	writes.length = 0
	lines = lines.map((line, i) => (i === 0 ? "changed-line-0" : line))
	tui.requestRender(false)
	await flushRender()

	const followUpOutput = writes.join("")
	expect(followUpOutput).not.toContain("\x1b[2J")
	expect(followUpOutput).not.toContain("\x1b[3J")
	// No visible lines were re-emitted.
	expect(countRenderedLines(followUpOutput)).toBe(0)
})

it("only renders visible changes when scrollback + viewport both change", async () => {
	const { writes, terminal } = makeMockTerminal()
	const tui = new TUI(terminal, false)

	let lines = Array.from({ length: 50 }, (_, i) => `line-${i}`)
	tui.addChild({
		render: () => lines,
		invalidate: () => {},
	})

	tui.requestRender(true)
	await flushRender()

	const initialOutput = writes.join("")
	expect(initialOutput).toContain("\x1b[2J")
	expect(countRenderedLines(initialOutput)).toBe(50)

	// Change line 0 (scrollback) and line 49 (visible). The renderer should
	// clamp the diff to the visible viewport and avoid a full clear+redraw.
	writes.length = 0
	lines = lines.map((line, i) => {
		if (i === 0) return "changed-line-0"
		if (i === 49) return "changed-line-49"
		return line
	})
	tui.requestRender(false)
	await flushRender()

	const followUpOutput = writes.join("")
	expect(followUpOutput).not.toContain("\x1b[2J")
	expect(followUpOutput).not.toContain("\x1b[3J")
	// It should render the changed visible line, not all 50 lines.
	expect(followUpOutput).toContain("changed-line-49")
	expect(countRenderedLines(followUpOutput)).toBeLessThan(50)
})
