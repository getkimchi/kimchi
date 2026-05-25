import { extractAnsiCode } from "@earendil-works/pi-tui/dist/utils.js"

/**
 * Strip ANSI / OSC / APC escape sequences from a string.
 *
 * Uses upstream {@link extractAnsiCode} so that OSC hyperlink resets
 * (e.g. `\x1b]8;;\x07`) and other non-CSI sequences are removed correctly.
 */
export function stripAnsi(s: string): string {
	if (!s.includes("\x1b")) return s
	let result = ""
	let i = 0
	while (i < s.length) {
		const ansi = extractAnsiCode(s, i)
		if (ansi) {
			i += ansi.length
			continue
		}
		result += s[i]
		i++
	}
	return result
}
