// Terminal-aware default for the fullscreen mouse-wheel scroll step
// (tui.wheelScrollLines / KIMCHI_WHEEL_SCROLL_LINES, consumed by the patched
// pi-tui TuiAltScreen).
//
// Background: pi-tui scrolls 1 line per wheel event by default. Terminals
// differ in how many SGR wheel events they emit per physical notch/gesture —
// there is NO escape sequence to negotiate wheel deltas, so the only way to
// adapt is env-var heuristics, same pattern as keyboard-capability.ts.
//
// We bump the default only where BOTH hold:
//   (a) user reports of painfully slow 1-line scrolling exist
//       (our own tickets for iTerm2/GoLand/Cursor; upstream pi issues
//       #7765, #8716 Windows Terminal, #8816 Kitty, #8471 WezTerm), and
//   (b) the terminal forwards wheel events 1:1, so multiplying the step
//       cannot double-apply a client-side multiplier.
//
// Deliberately NOT bumped:
//   - Alacritty: `scrolling.multiplier` (default 3) multiplies events
//     client-side before sending — bumping here would give 3x3.
//   - Termius: the upstream report (#8370) was trackpad gesture coalescing,
//     and its TERM_PROGRAM value is unverified. Revisit if a ticket arrives.
//   - Anything unknown/SSH/tmux-multiplexed: leaves the upstream default of 1.

/** Default step for terminals with slow 1-line wheel forwarding. Matches the OS-wide Windows convention of 3 lines/notch. */
export const SLOW_TERMINAL_WHEEL_SCROLL_LINES = 3

export interface WheelScrollDefault {
	lines: number
	/** Human-readable detection reason, shown by `kimchi config get`. */
	terminal: string
}

export function detectWheelScrollDefault(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): WheelScrollDefault | undefined {
	const slow = { lines: SLOW_TERMINAL_WHEEL_SCROLL_LINES }

	// Windows: the OS wheel convention is 3 lines per notch, so the 1-line
	// default feels ~3x slow in every terminal (Windows Terminal, ConHost,
	// VS Code host, …). One platform rule covers them all, including cases
	// where no terminal-specific env var exists.
	if (platform === "win32") return { ...slow, terminal: "Windows" }

	// JetBrains IDEs (GoLand, IntelliJ, …) — JediTerm dispatches 1 line per
	// notch. Same detection as keyboard-capability.ts.
	if (env.TERMINAL_EMULATOR?.startsWith("JetBrains-")) {
		return { ...slow, terminal: "JetBrains IDE" }
	}

	// Kitty does not set TERM_PROGRAM; its own markers are authoritative.
	if (env.KITTY_WINDOW_ID !== undefined || env.TERM === "xterm-kitty") {
		return { ...slow, terminal: "Kitty" }
	}

	switch (env.TERM_PROGRAM) {
		case "iTerm.app":
			return { ...slow, terminal: "iTerm2" }
		// VS Code integrated terminal — Cursor, Windsurf and VSCodium are
		// forks and report the same "vscode" value.
		case "vscode":
			return { ...slow, terminal: "VS Code-based editor" }
		case "WezTerm":
			// TERM_PROGRAM covers macOS/Linux; WEZTERM_PANE survives tmux.
			return { ...slow, terminal: "WezTerm" }
		default:
			if (env.WEZTERM_PANE !== undefined) return { ...slow, terminal: "WezTerm" }
			return undefined
	}
}
