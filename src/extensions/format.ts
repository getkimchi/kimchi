// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
export function formatCount(n: number): string {
	if (n >= 10_000_000) return `${Math.round(n / 1_000_000)}M`
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
	if (n >= 10_000) return `${Math.round(n / 1_000)}k`
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
	return String(n)
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`
	return `${(ms / 1000).toFixed(1)}s`
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
