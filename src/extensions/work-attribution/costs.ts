import type { WorkPullRequest } from "@getkimchi/kimchi-bridge/reconcile"
import type { WorkSegment } from "../work-attribution.js"
import type { WorkAccount } from "./scope.js"

/** Billing rows must already be joined to the exact request and scoped to its billing account. */
export interface RequestCostObservation {
	requestId: string
	billingRecordId: string
	/** Exact USD Decimal(18,9); null means the row has no known price yet. */
	costUsd: string | null
	/** Verified billing account; independent of the work selected before dispatch. */
	account?: WorkAccount
}

type Allocation = "pull-request" | "inferred" | "shared" | "unlinked" | "unmerged" | "post-merge" | "unknown"
type PriceStatus = "priced" | "missing" | "invalid" | "conflict"

export interface CostTotal {
	requestIds: string[]
	/** Known subtotal of the included requests. Missing or contradictory billing rows contribute no amount. */
	knownCostUsd: string
	/** Null until all included requests are priced and allocation is unambiguous. */
	totalCostUsd: string | null
}

export interface RequestCostAllocation {
	requestId: string
	/** Account captured with the request's work; null when missing or contradictory. */
	account: WorkAccount | null
	workIds: string[]
	/** Corrections affect allocation only; workIds keeps the request's original identity. */
	linkedWorkIds?: string[]
	linkIds?: string[]
	sessionIds: string[]
	startedAt: string | null
	pullRequestIds: string[]
	allocation: Allocation
	reason?:
		| "request-owner-conflict"
		| "request-time-missing"
		| "pull-request-conflict"
		| "pull-request-invalid"
		| "work-match-unresolved"
		| "work-account-unverified"
		| "work-account-mismatch"
		| "work-link-unresolved"
	segment?: WorkSegment
	billingRecordIds: string[]
	priceStatus: PriceStatus
	knownCostUsd: string
	totalCostUsd: string | null
}

export interface PullRequestCost extends CostTotal {
	/** Confirmed and inferred portions of the headline total. */
	explicit: CostTotal
	inferred: CostTotal
	/** Canonical provider identity; combine with account when comparing totals. */
	key: string
	account: WorkAccount | null
	/** Null when provider metadata is unusable or equally recent observations disagree. */
	pullRequest: WorkPullRequest | null
	workIds: string[]
	sharedRequestIds: string[]
	inferredRequestIds: string[]
	unknownRequestIds: string[]
}

export interface PullRequestCostReport {
	pullRequests: PullRequestCost[]
	requests: RequestCostAllocation[]
	unallocated: Record<Exclude<Allocation, "pull-request">, CostTotal>
}

const NANOS_PER_USD = 1_000_000_000n

export function decimalNanos(value: unknown): bigint | undefined {
	if (typeof value !== "string") return undefined
	const match = /^(0|[1-9]\d{0,8})(?:\.(\d{1,9}))?$/.exec(value)
	return match ? BigInt(match[1]) * NANOS_PER_USD + BigInt((match[2] ?? "").padEnd(9, "0")) : undefined
}

/** Render nanos as USD with nine decimals; a negative amount, such as a signed error, keeps its sign. */
export function usd(nanos: bigint): string {
	const absolute = nanos < 0n ? -nanos : nanos
	return `${nanos < 0n ? "-" : ""}${absolute / NANOS_PER_USD}.${(absolute % NANOS_PER_USD).toString().padStart(9, "0")}`
}

/** Sum calculated request amounts without imposing the API's per-bill size limit on their subtotal. */
export function totalRequestCosts(rows: readonly RequestCostAllocation[]): CostTotal {
	const knownCostUsd = usd(
		rows.reduce((sum, row) => {
			const [whole, fraction = ""] = row.knownCostUsd.split(".")
			return sum + BigInt(whole) * NANOS_PER_USD + BigInt(fraction.padEnd(9, "0"))
		}, 0n),
	)
	return {
		requestIds: rows.map((row) => row.requestId),
		knownCostUsd,
		totalCostUsd: rows.every((row) => row.priceStatus === "priced") ? knownCostUsd : null,
	}
}

/**
 * Text people read; saved reports keep `usd()`. PR costs are often cents or less, so like the PR costs console page
 * this keeps about three significant digits below $1, three decimals below $10 and cents from $10, rounding half up.
 */
export function roundedUsd(nanos: bigint): string {
	if (!nanos) return "$0.00"
	if (nanos < 1000n) return "<$0.000001"
	const places =
		nanos >= 10n * NANOS_PER_USD ? 2 : nanos >= NANOS_PER_USD ? 3 : Math.min(6, 12 - nanos.toString().length)
	const unit = 10n ** BigInt(places)
	const step = NANOS_PER_USD / unit
	const rounded = (nanos + step / 2n) / step
	const fraction = (rounded % unit).toString().padStart(places, "0").replace(/0+$/, "").padEnd(2, "0")
	return `$${(rounded / unit).toLocaleString("en-US")}.${fraction}`
}

export function time(value: unknown): number | undefined {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
	)
		return undefined
	const parsed = Date.parse(value)
	if (!Number.isFinite(parsed)) return undefined
	// Date.parse accepts impossible dates such as February 30 by rolling into the next month.
	const day = value.slice(0, 10)
	return new Date(`${day}T00:00:00Z`).toISOString().startsWith(day) ? parsed : undefined
}
