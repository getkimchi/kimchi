/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

/**
 * Lifetime usage components, accumulated via `message_end` events. Survives
 * compaction (which replaces session.state.messages and would reset any
 * stats-derived sum). cacheRead is excluded because each turn's cacheRead is
 * the cumulative cached prefix re-read on that one call — summing across
 * turns counts the prefix N times.
 */
export type LifetimeUsage = { input: number; output: number; cacheWrite: number }

/** Sum of lifetime usage components, or 0 if undefined. */
export function getLifetimeTotal(u?: LifetimeUsage): number {
	return u ? u.input + u.output + u.cacheWrite : 0
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
	into.input += delta.input
	into.output += delta.output
	into.cacheWrite += delta.cacheWrite
}

/** Minimal shape we read from upstream `getSessionStats()`. */
export type SessionStatsLike = {
	tokens: { input: number; output: number; cacheWrite: number }
	contextUsage?: { percent: number | null }
}
export type SessionLike = { getSessionStats(): SessionStatsLike }

/**
 * Session-scoped token count: input + output + cacheWrite as reported by
 * upstream `getSessionStats().tokens` for the *current* session window.
 */
export function getSessionTokens(session: SessionLike | undefined): number {
	if (!session) return 0
	try {
		const t = session.getSessionStats().tokens
		return t.input + t.output + t.cacheWrite
	} catch {
		return 0
	}
}

/**
 * Context-window utilization (0–100), or null when unavailable.
 */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
	if (!session) return null
	try {
		return session.getSessionStats().contextUsage?.percent ?? null
	} catch {
		return null
	}
}
