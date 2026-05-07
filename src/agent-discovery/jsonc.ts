// Minimal JSONC parser: strips // line comments and /* … */ block comments,
// but respects string literals so "//" inside "https://…" survives.
// Does not support trailing commas (matches JSON.parse constraint).
export function parseJsonc(raw: string): unknown {
	let result = ""
	let i = 0
	const len = raw.length

	while (i < len) {
		const ch = raw[i]

		if (ch === '"') {
			// String literal — copy verbatim
			result += ch
			i++
			while (i < len) {
				const c = raw[i]
				result += c
				i++
				if (c === "\\") {
					// Escape sequence — copy one more char
					if (i < len) {
						result += raw[i]
						i++
					}
				} else if (c === '"') {
					break
				}
			}
		} else if (ch === "/" && i + 1 < len && raw[i + 1] === "/") {
			// Line comment — skip to end of line
			while (i < len && raw[i] !== "\n" && raw[i] !== "\r") {
				i++
			}
		} else if (ch === "/" && i + 1 < len && raw[i + 1] === "*") {
			// Block comment — skip until */
			i += 2
			while (i < len) {
				if (raw[i] === "*" && i + 1 < len && raw[i + 1] === "/") {
					i += 2
					break
				}
				i++
			}
		} else {
			result += ch
			i++
		}
	}

	return JSON.parse(result)
}
