// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
// Shared poll-until-ready helper for ACP unit tests (watcher/refresher timing
// is nondeterministic — a debounce fires on the event loop, not the test's).
export async function waitFor(
	condition: () => boolean,
	opts?: { timeoutMs?: number; message?: () => string },
): Promise<void> {
	const deadline = Date.now() + (opts?.timeoutMs ?? 2000)
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(opts?.message?.() ?? "waitFor: timed out")
		await new Promise<void>((r) => setTimeout(r, 10))
	}
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
