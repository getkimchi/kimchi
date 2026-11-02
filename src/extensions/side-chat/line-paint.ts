/**
 * ANSI line helpers for painting over a rendered fullscreen frame.
 *
 * pi-tui's slicing/compositing drops zero-width APC markers, including the
 * hardware-cursor marker the renderer later extracts — so anything that
 * paints over a row that holds the cursor must lift it out and put it back.
 */

import { CURSOR_MARKER, compositeTuiLine, visibleWidth } from "@earendil-works/pi-tui"

export function withoutCursorMarker(line: string): string {
	return line.replace(CURSOR_MARKER, "")
}

/** `compositeTuiLine` that keeps the cursor marker at its original column. */
export function compositeKeepingCursor(
	line: string,
	overlay: string,
	column: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	const markerIndex = line.indexOf(CURSOR_MARKER)
	if (markerIndex === -1) return compositeTuiLine(line, overlay, column, overlayWidth, totalWidth)
	const markerColumn = visibleWidth(line.slice(0, markerIndex))
	const composited = compositeTuiLine(withoutCursorMarker(line), overlay, column, overlayWidth, totalWidth)
	return insertAtColumn(composited, markerColumn, CURSOR_MARKER)
}

/**
 * Re-apply `bg` after every SGR that resets the background (`0`, `49`, or an
 * empty parameter list), skipping the operands of extended colour codes.
 */
export function reapplyBackground(line: string, bg: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR escape sequences
	return line.replace(/\x1b\[([\d;]*)m/g, (sequence, params: string) => {
		const codes = params === "" ? [0] : params.split(";").map((code) => Number(code || 0))
		let resets = false
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i]
			if (code === 38 || code === 48 || code === 58) {
				i += codes[i + 1] === 2 ? 4 : 2
				continue
			}
			if (code === 0 || code === 49) resets = true
		}
		return resets ? sequence + bg : sequence
	})
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const TOKEN_RE = /\x1b\[[0-9;:?]*[A-Za-z]|\x1b_[^\x07]*\x07|\x1b\][^\x07]*(?:\x07|\x1b\\)|[\s\S]/gu

/** Insert a zero-width `marker` before the cell at visible `column`, keeping styling intact. */
export function insertAtColumn(line: string, column: number, marker: string): string {
	let width = 0
	for (const match of line.matchAll(TOKEN_RE)) {
		const token = match[0]
		if (token.startsWith("\x1b")) continue
		if (width >= column) return line.slice(0, match.index) + marker + line.slice(match.index)
		width += visibleWidth(token)
	}
	return line + marker
}
