import { describe, expect, it } from "vitest"
import { detectWheelScrollDefault, SLOW_TERMINAL_WHEEL_SCROLL_LINES } from "./wheel-scroll.js"

describe("detectWheelScrollDefault", () => {
	it("defaults to 3 on Windows regardless of terminal", () => {
		expect(detectWheelScrollDefault({}, "win32")).toEqual({
			lines: SLOW_TERMINAL_WHEEL_SCROLL_LINES,
			terminal: "Windows",
		})
		// Even a terminal with no other markers (ConHost-hosted shell).
		expect(detectWheelScrollDefault({}, "win32")?.terminal).toBe("Windows")
	})

	it("detects Windows Terminal inside WSL via WT_SESSION", () => {
		// WSL reports process.platform === "linux", but Windows Terminal sets
		// WT_SESSION and WSL inherits it for sessions the terminal launches.
		expect(detectWheelScrollDefault({ WT_SESSION: "abc" }, "linux")).toEqual({
			lines: SLOW_TERMINAL_WHEEL_SCROLL_LINES,
			terminal: "Windows Terminal",
		})
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
		// TERM is forwarded over ssh; the bump intentionally follows it — the
		// remote app receives Kitty's 1:1 wheel events unchanged.
		expect(
			detectWheelScrollDefault({ TERM: "xterm-kitty", SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" }, "linux")?.terminal,
		).toBe("Kitty")
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

	it("terminal-specific markers win over the WT_SESSION fallback", () => {
		// A Windows Terminal session can still host a ssh/tmux chain where a
		// closer marker describes reality better; order keeps WT last among
		// terminal rules… but with no other marker WT_SESSION still wins.
		expect(
			detectWheelScrollDefault({ WT_SESSION: "abc", TERMINAL_EMULATOR: "JetBrains-JediTerm" }, "linux")?.terminal,
		).toBe("JetBrains IDE")
	})
})
