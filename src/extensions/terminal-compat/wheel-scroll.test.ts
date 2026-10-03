import { describe, expect, it } from "vitest"
import { detectWheelScrollDefault, SLOW_TERMINAL_WHEEL_SCROLL_LINES } from "./wheel-scroll.js"

describe("detectWheelScrollDefault", () => {
	it("defaults to 3 on Windows regardless of terminal", () => {
		expect(detectWheelScrollDefault({}, "win32")).toEqual({
			lines: SLOW_TERMINAL_WHEEL_SCROLL_LINES,
			terminal: "Windows",
		})
		// Even a terminal with no other markers (ConHost-hosted shell).
		expect(detectWheelScrollDefault({ WT_SESSION: "abc" }, "win32")?.lines).toBe(SLOW_TERMINAL_WHEEL_SCROLL_LINES)
	})

	it("detects iTerm2", () => {
		expect(detectWheelScrollDefault({ TERM_PROGRAM: "iTerm.app" }, "darwin")).toEqual({
			lines: SLOW_TERMINAL_WHEEL_SCROLL_LINES,
			terminal: "iTerm2",
		})
	})

	it("detects the vscode family (VS Code, Cursor, Windsurf, VSCodium)", () => {
		expect(detectWheelScrollDefault({ TERM_PROGRAM: "vscode" }, "darwin")).toEqual({
			lines: SLOW_TERMINAL_WHEEL_SCROLL_LINES,
			terminal: "VS Code-based editor",
		})
	})

	it("detects JetBrains IDE variants", () => {
		for (const emulator of ["JetBrains-JediTerm", "JetBrains-Terminal-2025"]) {
			expect(detectWheelScrollDefault({ TERMINAL_EMULATOR: emulator }, "darwin")).toEqual({
				lines: SLOW_TERMINAL_WHEEL_SCROLL_LINES,
				terminal: "JetBrains IDE",
			})
		}
	})

	it("detects WezTerm via TERM_PROGRAM or WEZTERM_PANE", () => {
		expect(detectWheelScrollDefault({ TERM_PROGRAM: "WezTerm" }, "linux")?.terminal).toBe("WezTerm")
		// WEZTERM_PANE survives tmux rewriting TERM_PROGRAM.
		expect(detectWheelScrollDefault({ TERM_PROGRAM: "tmux", WEZTERM_PANE: "0" }, "linux")?.terminal).toBe("WezTerm")
	})

	it("detects Kitty via KITTY_WINDOW_ID or TERM", () => {
		expect(detectWheelScrollDefault({ KITTY_WINDOW_ID: "1" }, "linux")?.terminal).toBe("Kitty")
		expect(detectWheelScrollDefault({ TERM: "xterm-kitty" }, "linux")?.terminal).toBe("Kitty")
	})

	it("leaves unreported terminals at the upstream default", () => {
		// Alacritty multiplies wheel events client-side — bumping here too would double-apply.
		for (const env of [
			{ TERM_PROGRAM: "Alacritty" },
			{ TERM_PROGRAM: "Apple_Terminal" },
			{ TERM_PROGRAM: "ghostty" },
			{ TERM_PROGRAM: "tmux" },
			{},
		]) {
			expect(detectWheelScrollDefault(env, "darwin")).toBeUndefined()
		}
	})

	it("terminal-specific markers win over a Windows-unsettable unknown shell", () => {
		// Sanity: non-Windows platforms never hit the platform rule.
		expect(detectWheelScrollDefault({ WT_SESSION: "abc" }, "linux")).toBeUndefined()
	})
})
