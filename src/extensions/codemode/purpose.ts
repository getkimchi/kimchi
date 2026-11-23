export const CODEMODE_PURPOSE_MAX_CHARS = 120

const PURPOSE_PREFIX = "// @description:"
const OPTIONS_PREFIX = "// @options:"

/** Read the optional purpose from its only valid positions: source line one,
 *  or immediately after @options. Invalid presentation metadata is ignored. */
export function codemodePurpose(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined
	const code = Reflect.get(args, "code")
	if (typeof code !== "string") return undefined
	const lines = code.split("\n")
	// Match execution: @options is invalid anywhere except the first line,
	// including after an otherwise-valid purpose directive.
	if (lines.some((line, index) => index > 0 && line.trimStart().startsWith(OPTIONS_PREFIX))) return undefined
	let index = 0
	if (lines[0]?.trimStart().startsWith(OPTIONS_PREFIX)) index = 1
	const line = lines[index]
	if (!line?.trimStart().startsWith(PURPOSE_PREFIX)) return undefined
	const raw = line.trimStart().slice(PURPOSE_PREFIX.length).trim()
	const purpose = raw.replace(/\s+/g, " ")
	if (!purpose || purpose.length > CODEMODE_PURPOSE_MAX_CHARS) return undefined
	return purpose
}
