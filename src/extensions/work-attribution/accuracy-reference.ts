import {
	type AttributionAccuracyResult,
	compareAttributionAccuracy,
	isAccuracyAccount,
	isAccuracyPullRequestKey,
	text,
} from "./accuracy.js"
import { decimalNanos, usd } from "./costs.js"
import { sameWorkAccount, type WorkAccount } from "./scope.js"
import { object } from "./summary.js"

type Unallocated = "inferred" | "shared" | "unlinked" | "unmerged" | "post-merge" | "unknown"
type ExpectedOwnership =
	| { kind: "pull-request"; pullRequestId: string }
	| { kind: "shared"; pullRequestIds: string[] }
	| { kind: "no-pr"; reason: "unlinked" | "unmerged" | "post-merge" }
	| { kind: "unknown" }

interface ReferenceRequest {
	requestId: string
	account: WorkAccount | undefined
	nanos: bigint | undefined
	expected: ExpectedOwnership
}

interface Issue {
	kind: string
	requestId: string | null
	detail: string
}

interface ExpectedTotal {
	requestIds: string[]
	sharedRequestIds: string[]
	nanos: bigint
	priced: boolean
}

interface PullIdentity {
	key: string
	account: WorkAccount
}

export interface IndependentAccuracyResult {
	comparison: AttributionAccuracyResult
	referenceRequests: number
	referenceKnownCostUsd: string
	pullRequests: (PullIdentity & { reportedCostUsd: string; expectedCostUsd: string | null; errorUsd: string | null })[]
	sumAbsolutePullRequestErrorUsd: string | null
	problems: Issue[]
	differences: Issue[]
	complete: boolean
	matches: boolean
}

const UNALLOCATED: Unallocated[] = ["inferred", "shared", "unlinked", "unmerged", "post-merge", "unknown"]

/** Validate the version here; each reference entry is checked separately to expose all gaps. */
export function isAttributionReference(value: unknown): value is { version: 1; requests: unknown[] } {
	return object(value) && value.version === 1 && Array.isArray(value.requests)
}

function identifiers(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every((id) => typeof id === "string" && id.length > 0) &&
		new Set(value).size === value.length
	)
}

function sameIds(actual: unknown, expected: readonly string[]): boolean {
	return identifiers(actual) && actual.length === expected.length && actual.every((id) => expected.includes(id))
}

function ownership(value: unknown): ExpectedOwnership | undefined {
	if (!object(value)) return undefined
	if (
		value.kind === "pull-request" &&
		typeof value.pullRequestId === "string" &&
		isAccuracyPullRequestKey(value.pullRequestId)
	)
		return { kind: "pull-request", pullRequestId: value.pullRequestId }
	if (
		value.kind === "shared" &&
		identifiers(value.pullRequestIds) &&
		value.pullRequestIds.length > 1 &&
		value.pullRequestIds.every(isAccuracyPullRequestKey)
	)
		return { kind: "shared", pullRequestIds: [...value.pullRequestIds].sort() }
	if (
		value.kind === "no-pr" &&
		(value.reason === undefined ||
			value.reason === "unlinked" ||
			value.reason === "unmerged" ||
			value.reason === "post-merge")
	)
		return { kind: "no-pr", reason: value.reason ?? "unlinked" }
	if (value.kind === "unknown") return { kind: "unknown" }
	return undefined
}

function empty(): ExpectedTotal {
	return { requestIds: [], sharedRequestIds: [], nanos: 0n, priced: true }
}

function groupKey(key: string, account: WorkAccount): string {
	return JSON.stringify([account.apiUrl, account.organizationId, account.userId, key])
}

/** Independent inventory and receipts are supplied by the caller, never reconstructed from the report. */
export function compareIndependentAttribution(
	report: { requests: readonly unknown[]; pullRequests?: unknown; unallocated?: unknown },
	reference: { version: 1; requests: readonly unknown[] },
): IndependentAccuracyResult {
	const problems: Issue[] = []
	const differences: Issue[] = []
	const entries: ReferenceRequest[] = []
	for (const raw of reference.requests) {
		const requestId = object(raw) && typeof raw.requestId === "string" && raw.requestId ? raw.requestId : null
		const expected = object(raw) ? ownership(raw.expected) : undefined
		if (!requestId || !expected || !object(raw)) {
			problems.push({
				kind: "invalid-label",
				requestId,
				detail: "reference entry needs a requestId and valid expected ownership",
			})
			continue
		}
		const nanos = decimalNanos(raw.costUsd)
		const account = isAccuracyAccount(raw.account) ? raw.account : undefined
		if (!account)
			problems.push({
				kind: "unverified-reference-account",
				requestId,
				detail: "independent receipt has no valid account evidence",
			})
		if (nanos === undefined)
			problems.push({ kind: "unpriced-reference", requestId, detail: "independent receipt has no valid price" })
		if (expected.kind === "unknown")
			problems.push({ kind: "unknown-reference", requestId, detail: "human ownership is unresolved" })
		entries.push({ requestId, account, nanos, expected })
	}

	const unique = new Map<string, ReferenceRequest>()
	const duplicates = new Set<string>()
	for (const entry of entries) {
		if (unique.has(entry.requestId) || duplicates.has(entry.requestId)) {
			duplicates.add(entry.requestId)
			unique.delete(entry.requestId)
		} else unique.set(entry.requestId, entry)
	}
	// An entry without account evidence is still a label; its unverified-reference-account problem keeps this incomplete.
	const comparison = compareAttributionAccuracy(
		report.requests,
		entries.map((entry) => ({
			...entry,
			expectedAccount: entry.account,
			expectedPullRequestId: entry.expected.kind === "pull-request" ? entry.expected.pullRequestId : null,
		})),
		{
			// Repeated entries must also agree on the receipt and the complete ownership label.
			sameEvidence: (left, right) =>
				left.nanos === right.nanos && JSON.stringify(left.expected) === JSON.stringify(right.expected),
			// Weight assignment quality by independent receipts, while keeping observed coverage unchanged.
			priceOf: (requestId) => unique.get(requestId)?.nanos,
		},
	)
	problems.push(...comparison.problems)
	const { rows } = comparison

	const expectedPRs = new Map<string, ExpectedTotal & PullIdentity>()
	const expectedUnallocated = new Map(UNALLOCATED.map((kind) => [kind, empty()]))
	const pr = (key: string, account: WorkAccount) => {
		const id = groupKey(key, account)
		let total = expectedPRs.get(id)
		if (!total) {
			total = { ...empty(), key, account }
			expectedPRs.set(id, total)
		}
		return total
	}
	let referenceNanos = 0n
	for (const { requestId, account, nanos, expected } of unique.values()) {
		referenceNanos += nanos ?? 0n
		const row = rows.get(requestId)
		if (row && account && isAccuracyAccount(row.account) && !sameWorkAccount(row.account, account))
			differences.push({
				kind: "account-mismatch",
				requestId,
				detail: "report request account differs from the independent receipt",
			})
		if (row && row.priceStatus === "priced" && nanos !== undefined)
			for (const field of ["knownCostUsd", "totalCostUsd"] as const) {
				const reported = decimalNanos(row[field])
				if (reported !== undefined && reported !== nanos)
					differences.push({
						kind: "price-mismatch",
						requestId,
						detail: `reported ${field} ${text(row[field])} USD; independent receipt ${usd(nanos)} USD`,
					})
			}
		const allocation = expected.kind === "no-pr" ? expected.reason : expected.kind
		const expectedIds =
			expected.kind === "pull-request"
				? [expected.pullRequestId]
				: expected.kind === "shared"
					? expected.pullRequestIds
					: undefined
		if (
			row &&
			expected.kind !== "unknown" &&
			(row.allocation !== allocation || (expectedIds && !sameIds(row.pullRequestIds, expectedIds)))
		)
			differences.push({
				kind: "ownership-mismatch",
				requestId,
				detail: `reported ${text(row.allocation)}; expected ${allocation}`,
			})

		const total =
			expected.kind === "pull-request"
				? account && pr(expected.pullRequestId, account)
				: expectedUnallocated.get(expected.kind === "no-pr" ? expected.reason : expected.kind)
		if (total) {
			total.requestIds.push(requestId)
			total.nanos += nanos ?? 0n
			total.priced &&= nanos !== undefined
		}
		if (expected.kind === "shared" && account)
			for (const key of expected.pullRequestIds) pr(key, account).sharedRequestIds.push(requestId)
	}

	// Reported confidence reconciles bookkeeping; only the reference supplies ownership and prices.
	const reportedPRs = new Map<
		string,
		PullIdentity & { explicit: ExpectedTotal; inferred: ExpectedTotal; inferredRequestIds: string[] }
	>()
	const inferredTotal = expectedUnallocated.get("inferred")
	for (const [requestId, row] of rows) {
		if (row.allocation !== "pull-request" && row.allocation !== "inferred") continue
		const nanos = decimalNanos(row.knownCostUsd)
		if (row.allocation === "inferred" && inferredTotal) {
			inferredTotal.requestIds.push(requestId)
			inferredTotal.nanos += nanos ?? 0n
			inferredTotal.priced &&= row.priceStatus === "priced" && nanos !== undefined
		}
		if (
			!identifiers(row.pullRequestIds) ||
			!row.pullRequestIds.length ||
			!row.pullRequestIds.every(isAccuracyPullRequestKey)
		) {
			problems.push({
				kind: "invalid-report-row",
				requestId,
				detail: "assigned request needs complete, unique PR keys",
			})
			continue
		}
		if (!isAccuracyAccount(row.account)) continue
		for (const key of row.pullRequestIds) {
			const id = groupKey(key, row.account)
			const group = reportedPRs.get(id) ?? {
				key,
				account: row.account,
				explicit: empty(),
				inferred: empty(),
				inferredRequestIds: [],
			}
			if (row.allocation === "inferred") group.inferredRequestIds.push(requestId)
			if (row.pullRequestIds.length === 1) {
				const portion = group[row.allocation === "pull-request" ? "explicit" : "inferred"]
				const price = unique.get(requestId)?.nanos
				portion.requestIds.push(requestId)
				portion.nanos += price ?? 0n
				portion.priced &&= row.priceStatus === "priced" && price !== undefined
			}
			reportedPRs.set(id, group)
		}
	}

	const observedPRs = new Map<string, Record<string, unknown> & PullIdentity>()
	const duplicatePRs = new Set<string>()
	if (!Array.isArray(report.pullRequests))
		problems.push({ kind: "invalid-aggregate", requestId: null, detail: "report needs a pullRequests array" })
	else
		for (const entry of report.pullRequests) {
			if (
				!object(entry) ||
				typeof entry.key !== "string" ||
				!isAccuracyPullRequestKey(entry.key) ||
				!isAccuracyAccount(entry.account)
			) {
				problems.push({ kind: "invalid-aggregate", requestId: null, detail: "PR total needs a valid key and account" })
				continue
			}
			const id = groupKey(entry.key, entry.account)
			if (observedPRs.has(id) || duplicatePRs.has(id)) {
				duplicatePRs.add(id)
				observedPRs.delete(id)
				problems.push({ kind: "invalid-aggregate", requestId: null, detail: `duplicate PR total ${entry.key}` })
			} else observedPRs.set(id, { ...entry, key: entry.key, account: entry.account })
		}

	function checkTotal(
		actual: unknown,
		expected: ExpectedTotal,
		key: string,
		isPR: boolean,
		inferredIds: string[] = [],
	): bigint | undefined {
		if (
			!object(actual) ||
			!identifiers(actual.requestIds) ||
			decimalNanos(actual.knownCostUsd) === undefined ||
			(actual.totalCostUsd !== null && decimalNanos(actual.totalCostUsd) === undefined) ||
			(isPR &&
				(!identifiers(actual.sharedRequestIds) ||
					!identifiers(actual.inferredRequestIds) ||
					!identifiers(actual.unknownRequestIds)))
		) {
			problems.push({ kind: "invalid-aggregate", requestId: null, detail: `missing or invalid total for ${key}` })
			return undefined
		}
		const nanos = decimalNanos(actual.knownCostUsd)
		// Exclusive reference labels establish finality; empty groups use reported provider state.
		const finalAmountExpected =
			!isPR ||
			expected.requestIds.length > 0 ||
			(object(actual.pullRequest) && actual.pullRequest.state === "merged" && inferredIds.length === 0)
		const expectedTotal =
			finalAmountExpected && expected.priced && expected.sharedRequestIds.length === 0 ? expected.nanos : null
		if (isPR && !sameIds(actual.inferredRequestIds, inferredIds))
			differences.push({
				kind: "aggregate-mismatch",
				requestId: null,
				detail: `${key}: inferred request membership differs from observed rows`,
			})
		if (
			nanos !== expected.nanos ||
			!sameIds(actual.requestIds, expected.requestIds) ||
			(actual.totalCostUsd === null ? null : decimalNanos(actual.totalCostUsd)) !== expectedTotal ||
			(isPR && (!sameIds(actual.sharedRequestIds, expected.sharedRequestIds) || !sameIds(actual.unknownRequestIds, [])))
		)
			differences.push({
				kind: "aggregate-mismatch",
				requestId: null,
				detail: `${key}: report total or contributing requests differ from the reference`,
			})
		return nanos
	}

	const pullRequests: IndependentAccuracyResult["pullRequests"] = []
	let absoluteError = 0n
	for (const id of [...new Set([...expectedPRs.keys(), ...observedPRs.keys(), ...reportedPRs.keys()])].sort()) {
		const expected = expectedPRs.get(id) ?? empty()
		const actual = observedPRs.get(id)
		const identity = expectedPRs.get(id) ?? actual ?? reportedPRs.get(id)
		if (!identity) continue
		const { key, account } = identity
		const inferredIds = reportedPRs.get(id)?.inferredRequestIds ?? []
		if (actual)
			for (const portion of ["explicit", "inferred"] as const)
				checkTotal(actual[portion], reportedPRs.get(id)?.[portion] ?? empty(), `${key}.${portion}`, false)
		// An omitted nonzero PR is an observed zero, not an absent receipt.
		const nanos = actual ? checkTotal(actual, expected, key, true, inferredIds) : 0n
		if (!actual && !duplicatePRs.has(id))
			differences.push({ kind: "aggregate-mismatch", requestId: null, detail: `missing PR total ${key}` })
		if (!actual && inferredIds.length)
			differences.push({
				kind: "aggregate-mismatch",
				requestId: null,
				detail: `${key}: missing inferred request membership`,
			})
		if (nanos === undefined) continue
		const delta = nanos - expected.nanos
		absoluteError += delta < 0n ? -delta : delta
		pullRequests.push({
			key,
			account,
			reportedCostUsd: usd(nanos),
			expectedCostUsd: usd(expected.nanos),
			errorUsd: `${delta > 0n ? "+" : ""}${usd(delta)}`,
		})
	}
	for (const [key, expected] of expectedUnallocated)
		checkTotal(object(report.unallocated) ? report.unallocated[key] : undefined, expected, key, false)
	const complete = problems.length === 0
	if (!complete) {
		comparison.metrics = { correctCoveragePercent: null, wrongAssignmentPercent: null }
		comparison.requestMetrics = { correctCoveragePercent: null, wrongAssignmentPercent: null }
		for (const pr of pullRequests) {
			pr.expectedCostUsd = null
			pr.errorUsd = null
		}
	}
	return {
		comparison,
		referenceRequests: reference.requests.length,
		referenceKnownCostUsd: usd(referenceNanos),
		pullRequests,
		sumAbsolutePullRequestErrorUsd: complete ? usd(absoluteError) : null,
		problems,
		differences,
		complete,
		matches: complete && differences.length === 0,
	}
}
