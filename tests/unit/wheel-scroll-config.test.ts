import { TuiAltScreen } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeMockTerminal } from "./pi-tui-fake-terminal.js"

/**
 * Pins the kimchi patch in patches/@earendil-works__pi-tui@0.85.1.patch that
 * makes the fullscreen wheel-scroll step configurable via the
 * KIMCHI_WHEEL_SCROLL_LINES env var. These tests FAIL against an unpatched
 * pi-tui (env ignored, always 1) — that's intentional: they guard against the
 * patch being lost on a dependency upgrade or a broken pnpm patch state.
 */

const ENV_KEY = "KIMCHI_WHEEL_SCROLL_LINES"

function wheelScrollLinesOf(tui: TuiAltScreen): number {
	// Private field, runtime-visible; Record access pins the patch without
	// needing exports upstream doesn't provide.
	return (tui as unknown as Record<string, number>).wheelScrollLines
}

describe("TuiAltScreen KIMCHI_WHEEL_SCROLL_LINES patch", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("uses the env var when set to a positive integer", () => {
		vi.stubEnv(ENV_KEY, "4")
		const tui = new TuiAltScreen(makeMockTerminal().terminal)
		expect(wheelScrollLinesOf(tui)).toBe(4)
	})

	it.each(["0", "-2", "abc", "x2", ""])("falls back to 1 for invalid env %j", (value) => {
		vi.stubEnv(ENV_KEY, value)
		const tui = new TuiAltScreen(makeMockTerminal().terminal)
		expect(wheelScrollLinesOf(tui)).toBe(1)
	})

	// parseInt is intentionally lenient: leading digits win, trailing garbage
	// is ignored ("3.9" and "2x" both parse). Only fully unparseable values
	// fall back to the default.
	it.each([
		["3.9", 3],
		["2x", 2],
		[" 5 ", 5],
	])("lenient parse: env %j → %i", (value, expected) => {
		vi.stubEnv(ENV_KEY, value)
		const tui = new TuiAltScreen(makeMockTerminal().terminal)
		expect(wheelScrollLinesOf(tui)).toBe(expected)
	})

	it("defaults to 1 when the env var is unset", () => {
		delete process.env[ENV_KEY]
		const tui = new TuiAltScreen(makeMockTerminal().terminal)
		expect(wheelScrollLinesOf(tui)).toBe(1)
	})

	it("explicit option wins over the env var (forward-compatible with an upstream setting)", () => {
		vi.stubEnv(ENV_KEY, "4")
		const tui = new TuiAltScreen(makeMockTerminal().terminal, undefined, undefined, { wheelScrollLines: 7 })
		expect(wheelScrollLinesOf(tui)).toBe(7)
	})
})
