/**
 * PR display-metadata shaping kept for Kimchi's local cost-report and snapshot
 * construction (work-attribution/costs.ts, pr-cost-reporting/snapshot.ts and
 * events.ts). Everything else from the moved provider-records module comes
 * from @getkimchi/kimchi-bridge/reconcile; these three helpers are not on the
 * pinned barrel, and the bridge's own copies are internal to it (the same
 * boundary as machine.ts).
 */

const MAX_TITLE_CHARACTERS = 1024
const MAX_AUTHOR_CHARACTERS = 255

export function providerId(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value)
	if (typeof value === "string" && /^[1-9]\d{0,19}$/.test(value)) return value
}

export function pullRequestTitle(value: unknown): string | undefined {
	// Whole characters: cutting UTF-16 units could leave half a surrogate pair, which the server rejects.
	return typeof value === "string" && value ? Array.from(value).slice(0, MAX_TITLE_CHARACTERS).join("") : undefined
}

/** An author login; one past the bound is unknown rather than cut, because a shorter login names someone else. */
export function pullRequestAuthor(value: unknown): string | undefined {
	return typeof value === "string" && value && Array.from(value).length <= MAX_AUTHOR_CHARACTERS ? value : undefined
}
