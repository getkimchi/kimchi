import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Cache-metrics accounting extension.
 *
 * Emits cumulative `cache_summary` entries into the session JSONL on every turn_end so
 * benchmark parsers (analyze-session.py, terminal-bench tooling) can compute cache
 * economics without re-walking every message. Upstream usage objects carry
 * cacheRead/cacheWrite; this extension only accumulates them — no request or message
 * content is touched.
 *
 * Cumulative (rather than end-of-session) emission is deliberate: aborted sessions
 * may never reach session_shutdown, and turn-granularity entries let parsers chart
 * cache-ratio over time within a single run. Entries are small and deduped against
 * turns with no new assistant usage.
 */

export const CACHE_SUMMARY_ENTRY_TYPE = "cache_summary"
export const CACHE_SUMMARY_SCHEMA_VERSION = 1

export interface CacheSummaryAccumulation {
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	costDollars: number
	/** Assistant messages with a usable usage block. */
	messages: number
}

export interface CacheSummaryEntry {
	schemaVersion: number
	turnIndex: number
	cumulative: CacheSummaryAccumulation
}

interface UsageLike {
	input?: unknown
	output?: unknown
	cacheRead?: unknown
	cacheWrite?: unknown
	cost?: { total?: unknown }
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export default function cacheSummaryExtension(pi: ExtensionAPI): void {
	const totals: CacheSummaryAccumulation = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costDollars: 0,
		messages: 0,
	}
	let emittedForMessages = 0

	pi.on("message_end", (event) => {
		const message = event.message
		if (message.role !== "assistant") return
		const usage = (message as { usage?: UsageLike }).usage
		if (!usage || typeof usage.input !== "number") return
		totals.inputTokens += num(usage.input)
		totals.outputTokens += num(usage.output)
		totals.cacheReadTokens += num(usage.cacheRead)
		totals.cacheWriteTokens += num(usage.cacheWrite)
		totals.costDollars += num(usage.cost?.total)
		totals.messages += 1
	})

	pi.on("turn_end", (event) => {
		if (totals.messages === 0 || totals.messages === emittedForMessages) return
		emittedForMessages = totals.messages

		const entry: CacheSummaryEntry = {
			schemaVersion: CACHE_SUMMARY_SCHEMA_VERSION,
			turnIndex: event.turnIndex,
			cumulative: { ...totals, costDollars: Math.round(totals.costDollars * 1e9) / 1e9 },
		}
		pi.appendEntry(CACHE_SUMMARY_ENTRY_TYPE, entry)
	})
}
