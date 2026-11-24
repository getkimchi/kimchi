import { DISPLAY_LINE_MAX_CHARS, truncateForDisplay } from "./presentation.js"

export const CODEMODE_PURPOSE_MAX_CHARS = DISPLAY_LINE_MAX_CHARS

const PURPOSE_PREFIX = "// @description:"
const OPTIONS_PREFIX = "// @options:"
/** Every line terminator JavaScript recognizes, so a line comment never spans executable source. */
const LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029]/

/** Read the purpose from its only valid positions: source line one, or
 *  immediately after @options. A longer purpose is cut with an ellipsis. */
export function codemodePurpose(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined
	const code = Reflect.get(args, "code")
	if (typeof code !== "string") return undefined
	const lines = code.split(LINE_TERMINATOR)
	// Match execution: @options is invalid anywhere except the first line,
	// including after an otherwise-valid purpose directive.
	if (lines.some((line, index) => index > 0 && line.trimStart().startsWith(OPTIONS_PREFIX))) return undefined
	let index = 0
	if (lines[0]?.trimStart().startsWith(OPTIONS_PREFIX)) index = 1
	const line = lines[index]
	if (!line?.trimStart().startsWith(PURPOSE_PREFIX)) return undefined
	const raw = line.trimStart().slice(PURPOSE_PREFIX.length).trim()
	const purpose = raw.replace(/\s+/g, " ")
	if (!purpose) return undefined
	return truncateForDisplay(purpose, CODEMODE_PURPOSE_MAX_CHARS)
}
