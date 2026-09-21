import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { CustomEditor } from "@earendil-works/pi-coding-agent"
import type { EditorTheme, TUI } from "@earendil-works/pi-tui"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { RST_FG } from "../../ansi.js"

const CHEVRON_WIDTH = 2
const PLACEHOLDER_TEXT = "start typing to enter details"

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escapes
const ANSI_RE = /\x1b\[[^m]*m/g

/**
 * Replace the upstream hardware-cursor marker (`\x1b_pi:c`, optionally
 * terminated by BEL `\x07`) with a visible single-column cursor glyph
 * styled with the given accent ANSI prefix and reset suffix. Exported so
 * tests can verify the replacement in isolation from the upstream editor.
 */
export function replaceCursorMarker(line: string, accentFg: string, rstFg: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: marker is by definition a control-char sequence
	const cursorMarkerRe = /\x1b_pi:c\x07?/g
	return line.replace(cursorMarkerRe, `${accentFg}▏${rstFg}`)
}

/**
 * Whether a rendered line is one of the upstream editor's horizontal borders.
 *
 * Matches only lines that are *entirely* box-drawing characters or whitespace.
 * A prefix test (`/^─/`) would also match user text that happens to start with
 * `─`, slicing a real content line out of the render — the text would still be
 * submitted but stay invisible while typing. Exported for testing.
 */
export function isBorderLine(line: string): boolean {
	return /^[─\s]+$/.test(line.replace(ANSI_RE, ""))
}

/**
 * Minimal inline editor used by the feedback dialog. Differs from the main
 * `PromptEditor` in that it draws no top/bottom borders and shows a quiet
 * placeholder when empty.
 *
 * Multi-line input is supported out of the box: upstream `Editor` already
 * treats Shift+Enter (and the alt-enter escape sequences) as a newline and
 * Enter alone as submit.
 */
export class FeedbackEditor extends CustomEditor {
	private readonly appTheme: Theme

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, appTheme: Theme) {
		super(tui, editorTheme, keybindings)
		this.appTheme = appTheme
	}

	override render(width: number): string[] {
		const chevronColor = this.appTheme.getFgAnsi("accent")
		const muted = this.appTheme.getFgAnsi("muted")
		const contentWidth = Math.max(1, width - CHEVRON_WIDTH)

		// Empty state: render a single chevron + placeholder row and skip
		// the upstream render entirely so the dialog stays compact.
		if (this.getText().length === 0) {
			// Render a visible single-column cursor (`▏`). The upstream
			// `\x1b_pi:c\x07` marker is hardware-cursor-only and would leak
			// visibly as `pi:c` if emitted here, so we avoid it.
			const cursor = "▏"
			const budget = contentWidth - visibleWidth(cursor)
			const placeholder = budget >= visibleWidth(PLACEHOLDER_TEXT) ? PLACEHOLDER_TEXT : ""
			const used = visibleWidth(cursor) + visibleWidth(placeholder)
			const pad = " ".repeat(Math.max(0, width - CHEVRON_WIDTH - used))
			return [
				`${chevronColor}❯${RST_FG} ${chevronColor}${cursor}${RST_FG}${placeholder.length > 0 ? `${muted}${placeholder}${RST_FG}` : ""}${pad}`,
			].map((line) => truncateToWidth(line, width))
		}

		// Non-empty: render upstream at content width, strip top/bottom borders
		// (and any scroll-indicator borders), then prefix each remaining line
		// with the chevron (cursor row) or two spaces (other rows).
		const lines = super.render(contentWidth)

		let topIdx = -1
		for (let i = 0; i < lines.length; i++) {
			if (isBorderLine(lines[i])) {
				topIdx = i
				break
			}
		}
		let bottomIdx = -1
		for (let i = lines.length - 1; i >= 0; i--) {
			if (isBorderLine(lines[i])) {
				bottomIdx = i
				break
			}
		}

		const start = topIdx === -1 ? 0 : topIdx + 1
		const end = bottomIdx === -1 || bottomIdx <= start ? lines.length : bottomIdx

		const contentLines = lines.slice(start, end)
		const cursorIdx = contentLines.findIndex((l) => l.includes("\x1b_pi:c"))
		const safeCursorIdx = cursorIdx === -1 ? 0 : cursorIdx
		// Upstream emits `\x1b_pi:c\x07` as a hardware-cursor-only marker.
		// It has no visible rendering of its own, so when the upstream frame is
		// copied into our composite render the marker leaks into visible output
		// as the literal string `pi:c`. Replace it with a single-column cursor
		// glyph (`▏`) styled with the accent color before splicing it back in.
		const result: string[] = contentLines.map((line, i) => {
			const prefix = i === safeCursorIdx ? `${chevronColor}❯${RST_FG} ` : "  "
			const cleaned = i === safeCursorIdx ? replaceCursorMarker(line, chevronColor, RST_FG) : line
			const visLen = visibleWidth(cleaned)
			const pad = " ".repeat(Math.max(0, contentWidth - visLen))
			return `${prefix}${cleaned}${pad}`
		})

		return result.map((line) => truncateToWidth(line, width))
	}
}
