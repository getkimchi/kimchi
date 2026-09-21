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
 * Strip the upstream hardware-cursor marker (`\x1b_pi:c`, optionally
 * terminated by BEL `\x07`) from a line.
 *
 * The marker is a zero-width APC sequence that the TUI normally consumes to
 * place the *hardware* cursor. Upstream draws its own visible caret next to it
 * (a reverse-video `\x1b[7m` grapheme), so the marker must not be turned into a
 * glyph of its own: doing that renders two carets side by side, the painted one
 * and upstream's block. Removing it leaves exactly upstream's caret.
 *
 * Exported so tests can verify the strip in isolation from the upstream editor.
 */
export function stripCursorMarker(line: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: marker is by definition a control-char sequence
	const cursorMarkerRe = /\x1b_pi:c\x07?/g
	return line.replace(cursorMarkerRe, "")
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
 * Whether a rendered line is one of the upstream editor's *scroll* borders.
 *
 * When the text is taller than the visible window, upstream replaces the plain
 * rule with `─── ↑ N more ───` (see `createScrollBorder`). Those lines carry
 * digits and arrows, so `isBorderLine` rejects them. Exported for testing.
 */
export function isScrollBorderLine(line: string): boolean {
	return /^─+\s*[↑↓]\s*\d+\s*more\s*─*$/.test(line.replace(ANSI_RE, "").trim())
}

/**
 * The half-open range of `lines` holding the editor's actual content, i.e. the
 * upstream render minus its top and bottom border rows.
 *
 * Borders are identified *positionally* rather than by first/last match. A
 * scrolled editor's top border is `─── ↑ N more ───`, which is a border but
 * does not match `isBorderLine`; searching for the first plain rule would then
 * find the *bottom* border instead and slice away every content line, leaving
 * the editor looking empty while the user is still typing.
 *
 * Exported for testing.
 */
export function contentLineRange(lines: string[]): { start: number; end: number } {
	const isBorderAt = (i: number) => {
		const line = lines[i]
		return line !== undefined && (isBorderLine(line) || isScrollBorderLine(line))
	}
	const start = lines.length > 0 && isBorderAt(0) ? 1 : 0
	const lastIdx = lines.length - 1
	const end = lastIdx >= start && isBorderAt(lastIdx) ? lastIdx : lines.length
	return { start, end: Math.max(start, end) }
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
			// This branch never reaches upstream's renderer, so nothing else
			// draws a caret here — paint one, but only while focused, so an
			// unfocused editor doesn't show a caret that cannot be typed into.
			const cursor = this.focused ? "▏" : ""
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

		const { start, end } = contentLineRange(lines)
		const contentLines = lines.slice(start, end)
		const cursorIdx = contentLines.findIndex((l) => l.includes("\x1b_pi:c"))
		const safeCursorIdx = cursorIdx === -1 ? 0 : cursorIdx
		// Drop the zero-width hardware-cursor marker. Upstream already drew a
		// visible reverse-video caret next to it, so anything rendered in the
		// marker's place would show up as a second cursor.
		const result: string[] = contentLines.map((line, i) => {
			const prefix = i === safeCursorIdx ? `${chevronColor}❯${RST_FG} ` : "  "
			const cleaned = stripCursorMarker(line)
			const visLen = visibleWidth(cleaned)
			const pad = " ".repeat(Math.max(0, contentWidth - visLen))
			return `${prefix}${cleaned}${pad}`
		})

		return result.map((line) => truncateToWidth(line, width))
	}
}
