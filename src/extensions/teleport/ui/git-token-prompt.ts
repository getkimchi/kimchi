import type { Theme } from "@earendil-works/pi-coding-agent"
import { type Component, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"

// ── Types ────────────────────────────────────────────────────────────────────

export type GitTokenPromptEvent =
	| { kind: "char"; char: string }
	| { kind: "backspace" }
	| { kind: "toggle-save" }
	| { kind: "submit" }
	| { kind: "skip" }

export interface GitTokenPromptState {
	token: string
	saveForFuture: boolean
	host: string
}

export type GitTokenPromptResult = { outcome: "submitted"; token: string; save: boolean } | { outcome: "skipped" }

// ── Pure functions ───────────────────────────────────────────────────────────

export function initialGitTokenPromptState(host: string): GitTokenPromptState {
	return { token: "", saveForFuture: true, host }
}

export function reduceGitTokenPrompt(
	state: GitTokenPromptState,
	event: GitTokenPromptEvent,
): { state: GitTokenPromptState; result?: GitTokenPromptResult } {
	switch (event.kind) {
		case "char":
			return { state: { ...state, token: state.token + event.char } }
		case "backspace": {
			if (state.token.length === 0) return { state }
			return { state: { ...state, token: state.token.slice(0, -1) } }
		}
		case "toggle-save":
			return { state: { ...state, saveForFuture: !state.saveForFuture } }
		case "submit": {
			const trimmed = state.token.trim()
			if (trimmed.length === 0) return { state }
			return { state, result: { outcome: "submitted", token: trimmed, save: state.saveForFuture } }
		}
		case "skip":
			return { state, result: { outcome: "skipped" } }
	}
}

/**
 * Map raw terminal input to a prompt event.
 * Returns undefined for unrecognised input (the caller should ignore it).
 */
export function keyToGitTokenPromptEvent(data: string): GitTokenPromptEvent | undefined {
	if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return { kind: "skip" }
	if (matchesKey(data, Key.enter)) return { kind: "submit" }
	if (matchesKey(data, Key.tab)) return { kind: "toggle-save" }
	if (matchesKey(data, Key.backspace)) return { kind: "backspace" }

	// Bracketed paste: strip markers and treat contents as characters
	let cleaned = data
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (0x1b) is the escape code introducing bracketed paste
	if (cleaned.includes("\x1b[200~")) cleaned = cleaned.replace(/\x1b\[200~/g, "")
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (0x1b) is the escape code terminating bracketed paste
	if (cleaned.includes("\x1b[201~")) cleaned = cleaned.replace(/\x1b\[201~/g, "")

	// Accept printable characters (reject control chars)
	const hasControlChars = [...cleaned].some((ch) => {
		const code = ch.charCodeAt(0)
		return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
	})
	if (!hasControlChars && cleaned.length > 0) {
		return { kind: "char", char: cleaned }
	}

	return undefined
}

const MASK_CHAR = "●"

export function renderGitTokenPromptLines(state: GitTokenPromptState, theme: Theme, width: number): string[] {
	const lines: string[] = []
	const innerWidth = Math.max(1, width - 2)
	const add = (line = "") => lines.push(truncateToWidth(line, width, ""))
	const indent = "  "

	add("")
	add(`${indent}${theme.bold(theme.fg("accent", `Git repository detected (${state.host})`))}`)
	add("")
	for (const line of wrapTextWithAnsi(
		"Paste a personal access token so the remote session can push/pull:",
		Math.max(1, innerWidth - 2),
	)) {
		add(`${indent}${theme.fg("text", line)}`)
	}
	add("")

	// Masked token display
	const label = "Token: "
	if (state.token.length === 0) {
		add(`${indent}${theme.fg("dim", label)}${theme.fg("dim", "paste or type your token…")}`)
	} else {
		const masked = MASK_CHAR.repeat(Math.min(state.token.length, 40))
		const suffix = state.token.length > 40 ? theme.fg("dim", `… (${state.token.length} chars)`) : ""
		add(`${indent}${theme.fg("text", label)}${theme.fg("accent", masked)}${suffix}`)
	}

	add("")

	// Save checkbox
	const checkmark = state.saveForFuture ? "✓" : " "
	const checkboxStyle = state.saveForFuture ? "accent" : "dim"
	add(`${indent}[${theme.fg(checkboxStyle, checkmark)}] ${theme.fg("text", "Save for future sessions")}`)

	add("")

	// Key hints
	const hints = [
		`${theme.fg("dim", "[Enter]")} ${theme.fg("dim", "Continue")}`,
		`${theme.fg("dim", "[Tab]")} ${theme.fg("dim", "Toggle save")}`,
		`${theme.fg("dim", "[Esc]")} ${theme.fg("dim", "Skip")}`,
	]
	add(`${indent}${hints.join("  ")}`)
	add("")

	return lines
}

// ── Component ────────────────────────────────────────────────────────────────

export class GitTokenPromptComponent implements Component {
	private state: GitTokenPromptState

	constructor(
		private readonly theme: Theme,
		host: string,
		private readonly onDone: (result: GitTokenPromptResult) => void,
		private readonly requestRender: () => void,
	) {
		this.state = initialGitTokenPromptState(host)
	}

	getState(): GitTokenPromptState {
		return this.state
	}

	invalidate(): void {}

	render(width: number): string[] {
		return renderGitTokenPromptLines(this.state, this.theme, width)
	}

	handleInput(data: string): void {
		const event = keyToGitTokenPromptEvent(data)
		if (!event) return
		const next = reduceGitTokenPrompt(this.state, event)
		this.state = next.state
		if (next.result) {
			this.onDone(next.result)
			return
		}
		this.requestRender()
	}
}
