/**
 * What the side loop itself costs: decision-model calls, PR polls and the
 * time spent drawing. It never calls the chat model, so main-model tokens
 * stay at zero by construction; the ledger shows that rather than claiming it.
 */

/**
 * USD per million d3 input tokens, for the estimate only. d3 bills input
 * tokens (output is always 0). Unset → tokens are shown without a price.
 */
export const D3_PRICE_ENV = "KIMCHI_SIDE_LOOP_D3_USD_PER_MTOK"

export interface SideLoopStats {
	decisions: { calls: number; failures: number; inputTokens: number; totalMs: number; ruleFallbacks: number }
	polls: { calls: number; failures: number; totalMs: number }
	renders: { count: number; totalMs: number }
	surfaces: { created: number; updated: number; dropped: number }
	startedAt: number
}

export function createStats(now = Date.now()): SideLoopStats {
	return {
		decisions: { calls: 0, failures: 0, inputTokens: 0, totalMs: 0, ruleFallbacks: 0 },
		polls: { calls: 0, failures: 0, totalMs: 0 },
		renders: { count: 0, totalMs: 0 },
		surfaces: { created: 0, updated: 0, dropped: 0 },
		startedAt: now,
	}
}

export function d3PricePerMTok(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const value = Number(env[D3_PRICE_ENV])
	return env[D3_PRICE_ENV] && Number.isFinite(value) && value >= 0 ? value : undefined
}

const avg = (total: number, count: number) => (count ? Math.round(total / count) : 0)

/** Plain-text rows; the renderer styles them. */
export function formatStats(stats: SideLoopStats, price = d3PricePerMTok()): string[] {
	const { decisions: d, polls: p, renders: r, surfaces: s } = stats
	const cost = price === undefined ? "price unset" : `≈ $${((d.inputTokens / 1_000_000) * price).toFixed(5)}`
	return [
		`d3 decisions  ${d.calls} calls · ${d.inputTokens} in-tok · 0 out-tok · avg ${avg(d.totalMs, d.calls)} ms`,
		`              ${cost} · ${d.failures} failed · ${d.ruleFallbacks} by rule`,
		`main model    0 tokens (side loop never calls it)`,
		`PR polls      ${p.calls} · avg ${avg(p.totalMs, p.calls)} ms · ${p.failures} failed`,
		`renders       ${r.count} · ${r.totalMs.toFixed(1)} ms total · avg ${(r.count ? r.totalMs / r.count : 0).toFixed(2)} ms`,
		`cards         ${s.created} created · ${s.updated} updates · ${s.dropped} dropped`,
	]
}
