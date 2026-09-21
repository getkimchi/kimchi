import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"

/**
 * Shared frame drawing for the feedback dialogs.
 *
 * Pi's `Box` only applies padding and a background, and `DynamicBorder` draws a
 * plain horizontal rule — neither renders a titled box, so the frame is drawn
 * here. This module exists so the two feedback dialogs draw it exactly once
 * rather than keeping divergent copies of the same border arithmetic.
 *
 * `rawKeyHint` from pi-coding-agent is deliberately not used for hint rows: it
 * styles via the module-global `theme`, which is undefined for extensions
 * loaded through jiti (see the note on `DynamicBorder`). Dialogs pass their own
 * `Theme` instead.
 */
export interface DialogChrome {
	/** A blank row spanning the frame's interior. */
	emptyRow: string
	/**
	 * A row of content already styled by the caller. `rawLen` is the text's
	 * *unstyled* length, used for padding — ANSI escapes would otherwise be
	 * counted as visible columns.
	 */
	contentRow: (styledText: string, rawLen: string | number) => string
	/** A row whose visible width is measured rather than supplied, for pre-styled child renders. */
	measuredRow: (line: string) => string
	/** The frame's top edge with `title` centered inside it. */
	topBorder: (title: string) => string
	/** The frame's bottom edge. */
	bottomBorder: string
	/** Usable interior width, i.e. the width content rows are padded to. */
	contentWidth: number
}

export function createDialogChrome(theme: Theme, width: number): DialogChrome {
	const innerW = Math.max(1, width - 2)
	const contentW = Math.max(1, innerW - 4)
	const b = (s: string) => theme.fg("border", s)

	const contentRow = (styledText: string, rawLen: string | number): string => {
		const len = typeof rawLen === "number" ? rawLen : rawLen.length
		return `${b("│")}  ${styledText}${" ".repeat(Math.max(0, contentW - len))}  ${b("│")}`
	}

	return {
		contentWidth: contentW,
		emptyRow: `${b("│")}${" ".repeat(innerW)}${b("│")}`,
		contentRow,
		measuredRow: (line: string) => contentRow(line, visibleWidth(line)),
		topBorder: (title: string) => {
			const titleText = ` ${title} `
			const borderLen = Math.max(0, innerW - titleText.length)
			const leftB = Math.floor(borderLen / 2)
			const rightB = borderLen - leftB
			const titleStyled = theme.bold(theme.fg("accent", titleText))
			return `${b(`╭${"─".repeat(leftB)}`)}${titleStyled}${b(`${"─".repeat(rightB)}╮`)}`
		},
		bottomBorder: b(`╰${"─".repeat(innerW)}╯`),
	}
}
