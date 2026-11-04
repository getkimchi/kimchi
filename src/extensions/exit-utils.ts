// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
/**
 * Check if input is the bare "exit" alias (without leading slash).
 * When true, the input handler will trigger a graceful shutdown.
 */
export function isBareExitAlias(text: string): boolean {
	const trimmed = text.trim()
	return trimmed === "exit"
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
