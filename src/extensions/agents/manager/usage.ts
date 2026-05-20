// `cacheRead` was historically omitted from this shape because the original
// callers (agent-widget headline, prompt-summary) only treated cache-write as
// the "expensive" line. Once Agent results started flowing into prompt-summary
// via `buildDetails` in src/extensions/agents/index.ts, the omission silently
// reported 0 for delegated-agent cache reads — pi's SessionStats actually
// supplies the field (see node_modules/.../agent-session.d.ts). Tracking it
// here gives the prompt-summary subagent line correct cacheRead numbers.
export type LifetimeUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export function getLifetimeTotal(u?: LifetimeUsage): number {
	return u ? u.input + u.output + u.cacheWrite : 0
}

export function getOutputTotal(u?: LifetimeUsage): number {
	return u ? u.output : 0
}

export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
	into.input += delta.input
	into.output += delta.output
	into.cacheRead += delta.cacheRead
	into.cacheWrite += delta.cacheWrite
}

export type SessionStatsLike = {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
	contextUsage?: { percent: number | null }
}
export type SessionLike = { getSessionStats(): SessionStatsLike }

export function getSessionUsage(session: SessionLike | undefined): LifetimeUsage | undefined {
	if (!session) return undefined
	try {
		const t = session.getSessionStats().tokens
		return { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }
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
