/**
 * Focus chrome for the two prompt editors shown side by side.
 *
 * pi-tui's Editor always paints its (reverse-video) fake cursor, focused or
 * not (and kimchi's PromptEditor always emits the hardware-cursor marker
 * while empty), so with two editors on screen both look active. This decorates an
 * editor instance so that only the focused one shows a cursor, and the
 * focused one gets heavy accent borders with a labelled top border while the
 * other is thin and dim. Instance-level, reversible: the returned function
 * restores the editor exactly.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent"
import { CURSOR_MARKER, type Editor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"

const FAKE_CURSOR_START = "\x1b_pi:fc\x07"
const FAKE_CURSOR_END = "\x1b_pi:/fc\x07"

/** The editor members the chrome reads and decorates. */
export type DecoratableEditor = Pick<Editor, "focused" | "borderColor" | "render">

export interface FocusChromeOptions {
	label: string
	/** Colour override for the focused state (e.g. "success" while reviewing). */
	focusedColor?: () => ThemeColor | undefined
}

export function applyFocusChrome(target: DecoratableEditor, theme: Theme, options: FocusChromeOptions): () => void {
	const hadOwnRender = Object.hasOwn(target, "render")
	const originalRender = target.render
	let stored = target.borderColor

	const focusedColor = () => options.focusedColor?.() ?? "accent"
	Object.defineProperty(target, "borderColor", {
		configurable: true,
		enumerable: true,
		get: () => (text: string) =>
			target.focused ? theme.fg(focusedColor(), text.replaceAll("─", "━")) : theme.fg("dim", text),
		set: (value: (text: string) => string) => {
			stored = value
		},
	})

	const labelledBorder = (line: string, width: number, focused: boolean) => {
		// Only label a plain border; keep scroll/working-status indicators intact.
		if (!/^[─━]+$/.test(stripTerminalSequences(line))) return line
		const text = ` ${focused ? "●" : "○"} ${options.label} `
		const label = focused ? theme.bold(theme.fg(focusedColor(), text)) : theme.fg("dim", text)
		const prefix = `${target.borderColor("──")}${label}`
		const rest = width - visibleWidth(prefix)
		return rest < 2 ? line : `${prefix}${target.borderColor("─".repeat(rest))}`
	}

	target.render = function renderWithFocusChrome(this: DecoratableEditor, width: number) {
		const lines = originalRender.call(this, width)
		if (lines.length > 0) lines[0] = labelledBorder(lines[0], width, this.focused)
		if (this.focused) return lines
		// Unfocused: no fake cursor, and no hardware-cursor marker to steal the terminal cursor.
		return lines.map((line) =>
			line.replaceAll(FAKE_CURSOR_START, "").replaceAll(FAKE_CURSOR_END, "").replaceAll(CURSOR_MARKER, ""),
		)
	}

	return () => {
		Reflect.deleteProperty(target, "borderColor")
		target.borderColor = stored
		if (hadOwnRender) target.render = originalRender
		else Reflect.deleteProperty(target, "render")
	}
}
