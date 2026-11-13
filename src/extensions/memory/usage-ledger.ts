/**
 * Local usage ledger for memory's model spend — one append-only JSONL row
 * per call, at `<memory root>/usage.jsonl`. Makes "what did memory cost
 * last month" answerable locally (requests and input tokens per kind:
 * extraction, supersede judge, the d3 gates, embeddings) without depending
 * on server-side usage tracking — the gap behind the October incident's
 * 60M-token spike going unattributed for weeks.
 *
 * Recording is fail-soft by contract: a ledger failure (unwritable path,
 * disk full) logs once and never throws into the capture drain or the
 * session turn path — observability must not break capture. Volume is
 * small (~hundreds of rows/day, <100 bytes each); rotation is a future
 * concern if it ever matters.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { defaultMemoryDir } from "./backend.js"

/** Ledger row kinds — the call surfaces that record. Gate kinds (triage,
 * valuation, digest, recall, supersede, admin) identify the d3 gate via
 * decide()'s kind parameter; "extraction"/"supersede" mark the chat-model
 * funnel (chatJson); "embedding" marks the gateway embedder interceptor. */
export type UsageKind =
	| "extraction"
	| "supersede"
	| "triage"
	| "valuation"
	| "digest"
	| "recall"
	| "admin"
	| "embedding"
	| "d3"

export interface UsageRecord {
	kind: UsageKind
	/** The model id the call named (gateway alias), when known. */
	model?: string
	/** Input tokens as reported by the response; 0/absent for failed calls
	 * (a failed call records a row with failed: true — outage visibility
	 * without server-side data). */
	inputTokens?: number
	outputTokens?: number
	/** d3 calls: questions per systemone request. */
	questions?: number
	failed?: boolean
}

/** The ledger file path — exported for tests. */
export function usageLedgerPath(): string {
	return join(defaultMemoryDir(), "usage.jsonl")
}

let warnedBroken = false

/** Append one row; never throws (fail-soft by contract — see module header). */
export function recordUsage(record: UsageRecord): void {
	try {
		const path = usageLedgerPath()
		mkdirSync(dirname(path), { recursive: true })
		appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, "utf-8")
		warnedBroken = false
	} catch (err) {
		// One warning per outage streak, not per call: the drain can make
		// hundreds of calls, and the cause (permissions, disk) does not
		// change between them.
		if (!warnedBroken) {
			warnedBroken = true
			console.warn(
				"[memory] usage ledger unavailable (spend not recorded until it recovers):",
				err instanceof Error ? err.message : err,
			)
		}
	}
}
