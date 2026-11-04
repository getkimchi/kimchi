// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
const WORK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** UUID identity shared by local work records and saved plan metadata. */
export function isWorkId(value: unknown): value is string {
	return typeof value === "string" && WORK_ID_PATTERN.test(value)
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
