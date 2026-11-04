// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
/** Minimal tool result with text content and empty details. */
export function textResult(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} }
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
