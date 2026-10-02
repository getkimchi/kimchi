import { TuiMainScreen } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { makeMockTerminal } from "./pi-tui-fake-terminal.js"

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

/** Wait long enough for requestRender(true) -> process.nextTick -> doRender. */
function flushRender(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
	vi.stubEnv("PI_TUI_NO_CLEAR_SCROLLBACK", "1")
})

afterEach(() => {
	vi.unstubAllEnvs()
})

it("does not emit ESC[3J when PI_TUI_NO_CLEAR_SCROLLBACK=1", async () => {
	const { writes, terminal } = makeMockTerminal()
	const tui = new TuiMainScreen(terminal, false)

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
	const tui = new TuiMainScreen(terminal, false)

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
