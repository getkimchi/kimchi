// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
/** A URL with an allowed protocol and no credentials, query or fragment; otherwise undefined. */
export function plainURL(value: unknown, protocols: readonly string[] = ["https:"]): URL | undefined {
	if (typeof value !== "string") return undefined
	try {
		const url = new URL(value)
		if (protocols.includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) return url
	} catch {}
	return undefined
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
