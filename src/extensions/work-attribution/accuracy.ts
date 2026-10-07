import { decimalNanos, type RequestCostAllocation } from "./costs.js"
import { isWorkAccount, sameWorkAccount, type WorkAccount } from "./scope.js"
import { object } from "./summary.js"

/** A human-supplied expectation for one request; a null expectation means intentionally unassigned. */
export interface AttributionLabel {
	requestId: string
	expectedPullRequestId: string | null
	/** Supplied by the independent receipt; omitted only in the limited legacy label mode. */
	expectedAccount?: WorkAccount
}

export type AttributionAccuracyProblemKind =
	| "invalid-label"
	| "duplicate-label"
	| "conflicting-labels"
	| "invalid-expected-pull-request-id"
	| "missing-report-row"
	| "invalid-report-row"
	| "unlabelled-request"
	| "unpriced-request"
	| "unverified-report-account"

export interface AttributionAccuracyProblem {
	kind: AttributionAccuracyProblemKind
	requestId: string | null
	detail: string
}

export interface AttributionAccuracyBucket {
	requestIds: string[]
	knownCostUsd: string
	knownCostNanos: bigint
}

export interface AttributionAccuracyResult {
	reference: AttributionAccuracyBucket
	correct: AttributionAccuracyBucket
	wrong: AttributionAccuracyBucket
	missed: AttributionAccuracyBucket
	assigned: AttributionAccuracyBucket
	coverage: {
		reportRequests: number
		labelledRequests: number
		pricedRequests: number
		scoredRequests: number
		reportKnownCostUsd: string
		scoredKnownCostUsd: string
		unlabelledRequestIds: string[]
		unpricedRequestIds: string[]
	}
	metrics: { correctCoveragePercent: string | null; wrongAssignmentPercent: string | null }
	requestMetrics: { correctCoveragePercent: string | null; wrongAssignmentPercent: string | null }
	complete: boolean
	problems: AttributionAccuracyProblem[]
}

const NANOS_PER_USD = 1_000_000_000n
const PERCENT_SCALE = 100_000_000_000n
const EXPECTED_PULL_REQUEST_ID = /^[a-z]+:.+\/.+#[1-9]\d*$/

/** Accept provider IDs and complete keys from older URL-only records. */
export function isAccuracyPullRequestKey(value: string): boolean {
	if (/^(github|gitlab):[^/\s]+\/[^#\s]+\/[^#\s]+#[1-9]\d*$/.test(value)) return true
	try {
		const key: unknown = JSON.parse(value)
		if (!Array.isArray(key) || key.length !== 3) return false
		const [provider, host, id] = key
		return (
			(provider === "github" || provider === "gitlab") &&
			typeof host === "string" &&
			typeof id === "string" &&
			/^[1-9]\d*$/.test(id) &&
			new URL(`https://${host}`).host === host &&
			JSON.stringify(key) === value
		)
	} catch {
		return false
	}
}

function isExpectedPullRequestId(value: string): boolean {
	return isAccuracyPullRequestKey(value) || EXPECTED_PULL_REQUEST_ID.test(value)
}

/** Checks supplied evidence, without reading credentials or verifying an account over the network. */
export function isAccuracyAccount(value: unknown): value is WorkAccount {
	if (!object(value) || !isWorkAccount(value) || value.apiUrl.trim() !== value.apiUrl) return false
	try {
		const url = new URL(value.apiUrl)
		return (
			(url.protocol === "https:" || url.protocol === "http:") &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		)
	} catch {
		return false
	}
}

/** Render a rejected runtime value without coercing it — template literals throw on objects like { toString: null }. */
function text(value: unknown): string {
	return typeof value === "string" ? value : "<non-string>"
}

/** Exact integer rendering of a nanos amount at nine decimal places; never floats. */
function usd(nanos: bigint): string {
	return `${nanos / NANOS_PER_USD}.${(nanos % NANOS_PER_USD).toString().padStart(9, "0")}`
}

/** Truncated pure-integer share of the reference total, scaled by 100 and rendered at nine decimals. */
function percentage(nanos: bigint, referenceNanos: bigint): string {
	return usd((nanos * PERCENT_SCALE) / referenceNanos)
}

interface Totals {
	requestIds: string[]
	nanos: bigint
}

function bucket(totals: Totals): AttributionAccuracyBucket {
	return {
		requestIds: [...totals.requestIds].sort(),
		knownCostUsd: usd(totals.nanos),
		knownCostNanos: totals.nanos,
	}
}

interface Survivor extends AttributionLabel {
	row: RequestCostAllocation
	nanos: bigint
}

/** Compare human attribution labels against what a saved cost report actually allocated. Never mutates its inputs. */
export function compareAttributionAccuracy(
	requests: readonly RequestCostAllocation[],
	labels: readonly AttributionLabel[],
): AttributionAccuracyResult {
	const problems: AttributionAccuracyProblem[] = []

	// Stage 1 — label shape, in label input order; extra properties are tolerated.
	const shaped: AttributionLabel[] = []
	for (const entry of labels) {
		const requestId = object(entry) && typeof entry.requestId === "string" && entry.requestId ? entry.requestId : null
		const expected = object(entry) ? entry.expectedPullRequestId : undefined
		const account = object(entry) ? entry.expectedAccount : undefined
		if (
			requestId &&
			(typeof expected === "string" || expected === null) &&
			(account === undefined || isAccuracyAccount(account))
		)
			shaped.push({ requestId, expectedPullRequestId: expected, ...(account ? { expectedAccount: account } : {}) })
		else
			problems.push({
				kind: "invalid-label",
				requestId,
				detail: "label entry must have a non-empty string requestId and a string or null expectedPullRequestId",
			})
	}

	// Stage 2 — duplicate/conflict groups, ordered by first occurrence; duplicates are defects, never dedupe hints.
	const grouped = new Map<string, AttributionLabel[]>()
	for (const label of shaped) {
		const expectations = grouped.get(label.requestId)
		if (expectations) expectations.push(label)
		else grouped.set(label.requestId, [label])
	}
	const excluded = new Set<string>()
	for (const [requestId, expectations] of grouped) {
		if (expectations.length < 2) continue
		excluded.add(requestId)
		const first = expectations[0]
		const identical = expectations.every(
			(expectation) =>
				expectation.expectedPullRequestId === first.expectedPullRequestId &&
				(expectation.expectedAccount && first.expectedAccount
					? sameWorkAccount(expectation.expectedAccount, first.expectedAccount)
					: expectation.expectedAccount === first.expectedAccount),
		)
		problems.push({
			kind: identical ? "duplicate-label" : "conflicting-labels",
			requestId,
			detail: `request ${requestId} carries ${expectations.length} ${identical ? "identical duplicate" : "conflicting"} labels and is excluded from every bucket`,
		})
	}

	// Stage 4 — report rows, global scan in row order; its problems are reported after stage 3's.
	const rows = new Map<string, RequestCostAllocation>()
	const rowProblems: AttributionAccuracyProblem[] = []
	const duplicated = new Set<string>()
	const invalid = new Set<string>()
	requests.forEach((row, index) => {
		const requestId = object(row) && typeof row.requestId === "string" && row.requestId ? row.requestId : null
		if (requestId === null) {
			rowProblems.push({
				kind: "invalid-report-row",
				requestId: null,
				detail: `report row ${index} is not a usable request row: expected an object with a non-empty string requestId`,
			})
			return
		}
		if (rows.has(requestId) || duplicated.has(requestId)) {
			duplicated.add(requestId)
			rows.delete(requestId)
			rowProblems.push({
				kind: "invalid-report-row",
				requestId: null,
				detail: `report row ${index} repeats requestId ${requestId}; the request is unmatchable and excluded`,
			})
			return
		}
		rows.set(requestId, row)
		if (
			row.priceStatus === "priced" &&
			decimalNanos(row.knownCostUsd) !== undefined &&
			decimalNanos(row.totalCostUsd) === undefined
		) {
			invalid.add(requestId)
			rowProblems.push({
				kind: "invalid-report-row",
				requestId,
				detail: `priced report row ${index} needs a valid decimal totalCostUsd`,
			})
		}
		if (
			!["pull-request", "inferred", "shared", "unlinked", "unmerged", "post-merge", "unknown"].includes(
				row.allocation,
			) ||
			!Array.isArray(row.pullRequestIds) ||
			!row.pullRequestIds.every((id) => typeof id === "string" && isExpectedPullRequestId(id)) ||
			new Set(row.pullRequestIds).size !== row.pullRequestIds.length ||
			(row.allocation === "pull-request" && row.pullRequestIds.length !== 1)
		) {
			invalid.add(requestId)
			rowProblems.push({
				kind: "invalid-report-row",
				requestId,
				detail: `report row ${index} has invalid allocation or PR identifiers`,
			})
		}
	})

	// Stage 3 — per-label checks, in label input order; first failure wins, at most one problem per label.
	const survivors: Survivor[] = []
	for (const label of shaped) {
		if (excluded.has(label.requestId)) continue
		if (invalid.has(label.requestId)) continue
		const expected = label.expectedPullRequestId
		if (expected !== null && !isExpectedPullRequestId(expected)) {
			problems.push({
				kind: "invalid-expected-pull-request-id",
				requestId: label.requestId,
				detail: `label for request ${label.requestId} names a malformed expected pull request id ${expected}`,
			})
			continue
		}
		const row = rows.get(label.requestId)
		if (!row) {
			// A duplicated requestId is already recorded by its stage-4 problem; it stays silent here.
			if (!duplicated.has(label.requestId))
				problems.push({
					kind: "missing-report-row",
					requestId: label.requestId,
					detail: `label for request ${label.requestId} has no usable, unique row in the cost report`,
				})
			continue
		}
		if (label.expectedAccount && !isAccuracyAccount(row.account)) {
			problems.push({
				kind: "unverified-report-account",
				requestId: label.requestId,
				detail: "report request has no valid account evidence",
			})
			continue
		}
		const nanos = decimalNanos(row.knownCostUsd)
		if (row.priceStatus !== "priced" || nanos === undefined) {
			problems.push({
				kind: "unpriced-request",
				requestId: label.requestId,
				detail: `request ${label.requestId} has no confirmed price: priceStatus ${text(row.priceStatus)}, knownCostUsd ${text(row.knownCostUsd)}`,
			})
			continue
		}
		survivors.push({ ...label, row, nanos })
	}
	problems.push(...rowProblems)

	const unlabelledRequestIds: string[] = []
	const unpricedRequestIds: string[] = []
	let reportKnownNanos = 0n
	const alreadyUnpriced = new Set(
		problems.filter((problem) => problem.kind === "unpriced-request").map((problem) => problem.requestId),
	)
	for (const [requestId, row] of rows) {
		if (invalid.has(requestId)) continue
		const nanos = decimalNanos(row.knownCostUsd)
		reportKnownNanos += nanos ?? 0n
		if (!grouped.has(requestId)) {
			unlabelledRequestIds.push(requestId)
			problems.push({ kind: "unlabelled-request", requestId, detail: `request ${requestId} has no label` })
		}
		if (row.priceStatus !== "priced" || nanos === undefined) {
			unpricedRequestIds.push(requestId)
			if (!alreadyUnpriced.has(requestId))
				problems.push({ kind: "unpriced-request", requestId, detail: `request ${requestId} has no confirmed price` })
		}
	}

	// Classification — every surviving request is counted exactly once.
	const reference: Totals = { requestIds: [], nanos: 0n }
	const correct: Totals = { requestIds: [], nanos: 0n }
	const wrong: Totals = { requestIds: [], nanos: 0n }
	const missed: Totals = { requestIds: [], nanos: 0n }
	const assigned: Totals = { requestIds: [], nanos: 0n }
	const count = (target: Totals, requestId: string, nanos: bigint) => {
		target.requestIds.push(requestId)
		target.nanos += nanos
	}
	for (const { requestId, expectedPullRequestId, expectedAccount, row, nanos } of survivors) {
		const pullRequestIds = row.pullRequestIds
		const confident =
			row.allocation === "pull-request" &&
			Array.isArray(pullRequestIds) &&
			pullRequestIds.length === 1 &&
			typeof pullRequestIds[0] === "string"
		if (confident) count(assigned, requestId, nanos)
		if (expectedPullRequestId === null) {
			// Null-labeled confident spending is wrong only; non-confident rows land in no bucket at all.
			if (confident) count(wrong, requestId, nanos)
			continue
		}
		count(reference, requestId, nanos)
		if (!confident) count(missed, requestId, nanos)
		else if (
			pullRequestIds[0] === expectedPullRequestId &&
			(!expectedAccount || (isAccuracyAccount(row.account) && sameWorkAccount(row.account, expectedAccount)))
		)
			count(correct, requestId, nanos)
		else {
			count(wrong, requestId, nanos)
			count(missed, requestId, nanos)
		}
	}

	const referenceBucket = bucket(reference)
	const complete = problems.length === 0
	const rate = (numerator: bigint, denominator: bigint) =>
		complete && denominator > 0n ? percentage(numerator, denominator) : null
	return {
		reference: referenceBucket,
		correct: bucket(correct),
		wrong: bucket(wrong),
		missed: bucket(missed),
		assigned: bucket(assigned),
		coverage: {
			reportRequests: requests.length,
			labelledRequests: shaped.filter(
				(label) =>
					!excluded.has(label.requestId) &&
					!invalid.has(label.requestId) &&
					rows.has(label.requestId) &&
					(label.expectedPullRequestId === null || isExpectedPullRequestId(label.expectedPullRequestId)),
			).length,
			pricedRequests: [...rows.keys()].filter((id) => !invalid.has(id)).length - unpricedRequestIds.length,
			scoredRequests: survivors.length,
			reportKnownCostUsd: usd(reportKnownNanos),
			scoredKnownCostUsd: usd(survivors.reduce((sum, survivor) => sum + survivor.nanos, 0n)),
			unlabelledRequestIds: unlabelledRequestIds.sort(),
			unpricedRequestIds: unpricedRequestIds.sort(),
		},
		metrics: {
			correctCoveragePercent: rate(correct.nanos, reference.nanos),
			wrongAssignmentPercent: rate(wrong.nanos, assigned.nanos),
		},
		requestMetrics: {
			correctCoveragePercent: rate(BigInt(correct.requestIds.length), BigInt(reference.requestIds.length)),
			wrongAssignmentPercent: rate(BigInt(wrong.requestIds.length), BigInt(assigned.requestIds.length)),
		},
		complete,
		problems,
	}
}
