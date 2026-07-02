/**
 * Session-scoped ferment-offer decline memory.
 *
 * When the agent offers a ferment to the user via `ask_user` and the user
 * declines, this store records the decline for the current session so the
 * offer-policy prompt block can suppress re-offering. The flag is process-
 * scoped and lives only in memory — it is NOT persisted to disk and does not
 * survive a session restart, so a fresh session always starts un-declined.
 *
 * Mirrors the module-level Map pattern used in `nudge.ts` (e.g.
 * `reactiveNudgeCounts` / `stopNudgeCounts`): module-level state with
 * per-key get/set/delete helpers and a reset-all helper for tests.
 */

const declinedSessions = new Set<string>()

/** Mark that the user declined a ferment offer for this session. */
export function markDeclined(sessionId: string): void {
	declinedSessions.add(sessionId)
}

/** Returns true if the user has declined a ferment offer this session. */
export function isDeclined(sessionId: string): boolean {
	return declinedSessions.has(sessionId)
}

/** Clear the decline flag for one session. */
export function clearDeclined(sessionId: string): void {
	declinedSessions.delete(sessionId)
}

/** Clear all decline flags (useful for tests). */
export function clearAllDeclined(): void {
	declinedSessions.clear()
}
