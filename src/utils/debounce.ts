// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
/** Trailing-edge debounce: each schedule resets the window, fn fires once after waitMs of quiet. */
export function createDebounce(fn: () => void, waitMs: number): { schedule(): void; cancel(): void } {
	let timer: NodeJS.Timeout | undefined
	return {
		schedule() {
			if (timer !== undefined) clearTimeout(timer)
			timer = setTimeout(() => {
				timer = undefined
				fn()
			}, waitMs)
		},
		cancel() {
			if (timer !== undefined) {
				clearTimeout(timer)
				timer = undefined
			}
		},
	}
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
