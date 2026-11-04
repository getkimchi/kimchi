// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
export function stripOuterQuotes(value: string): string {
	const trimmed = value.trim()
	if (trimmed.length >= 2) {
		const first = trimmed[0]
		const last = trimmed[trimmed.length - 1]
		if ((first === `"` && last === `"`) || (first === `'` && last === `'`) || (first === "`" && last === "`")) {
			return trimmed.slice(1, -1).trim()
		}
	}
	return trimmed
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
