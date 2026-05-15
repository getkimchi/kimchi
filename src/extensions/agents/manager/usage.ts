export type LifetimeUsage = { input: number; output: number; cacheWrite: number }

export function getLifetimeTotal(u?: LifetimeUsage): number {
	return u ? u.input + u.output + u.cacheWrite : 0
}

export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
	into.input += delta.input
	into.output += delta.output
	into.cacheWrite += delta.cacheWrite
}

export type SessionStatsLike = {
	tokens: { input: number; output: number; cacheWrite: number }
	contextUsage?: { percent: number | null }
}
export type SessionLike = { getSessionStats(): SessionStatsLike }

export function getSessionUsage(session: SessionLike | undefined): LifetimeUsage | undefined {
	if (!session) return undefined
	try {
		const t = session.getSessionStats().tokens
		return { input: t.input, output: t.output, cacheWrite: t.cacheWrite }
	} catch {
		return undefined
	}
}

export function getSessionTokens(session: SessionLike | undefined): number {
	return getLifetimeTotal(getSessionUsage(session))
}

export function getSessionContextPercent(session: SessionLike | undefined): number | null {
	if (!session) return null
	try {
		return session.getSessionStats().contextUsage?.percent ?? null
	} catch {
		return null
	}
}
