// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
export function enableMouseCapture(): void {
	process.stdout.write("\x1b[?1000h\x1b[?1006h")
}

export function disableMouseCapture(): void {
	process.stdout.write("\x1b[?1000l\x1b[?1006l")
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
