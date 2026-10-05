import { type AttributionAccuracyResult, compareAttributionAccuracy, isAccuracyAccount } from "./accuracy.js"
import { decimalNanos, type RequestCostAllocation } from "./costs.js"
import { sameWorkAccount, type WorkAccount } from "./scope.js"

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
const PR_KEY = /^(github|gitlab):[^/\s]+\/[^#\s]+\/[^#\s]+#[1-9]\d*$/

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

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
	if (value.kind === "pull-request" && typeof value.pullRequestId === "string" && PR_KEY.test(value.pullRequestId))
		return { kind: "pull-request", pullRequestId: value.pullRequestId }
	if (
		value.kind === "shared" &&
		identifiers(value.pullRequestIds) &&
		value.pullRequestIds.length > 1 &&
		value.pullRequestIds.every((id) => PR_KEY.test(id))
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

function usd(nanos: bigint): string {
	const absolute = nanos < 0n ? -nanos : nanos
	return `${nanos < 0n ? "-" : ""}${absolute / 1_000_000_000n}.${(absolute % 1_000_000_000n).toString().padStart(9, "0")}`
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "<invalid>"
}

function empty(): ExpectedTotal {
	return { requestIds: [], sharedRequestIds: [], nanos: 0n, priced: true }
}

function groupKey(key: string, account: WorkAccount): string {
	return JSON.stringify([account.apiUrl, account.organizationId, account.userId, key])
}

/** Independent inventory and receipts are supplied by the caller, never reconstructed from the report. */
export function compareIndependentAttribution(
	report: { requests: readonly RequestCostAllocation[]; pullRequests?: unknown; unallocated?: unknown },
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
	const grouped = new Map<string, ReferenceRequest[]>()
	for (const entry of entries) {
		const group = grouped.get(entry.requestId) ?? []
		group.push(entry)
		grouped.set(entry.requestId, group)
		if (unique.has(entry.requestId) || duplicates.has(entry.requestId)) {
			duplicates.add(entry.requestId)
			unique.delete(entry.requestId)
		} else unique.set(entry.requestId, entry)
	}
	const labels = entries
		.filter((entry) => entry.account)
		.map(({ requestId, account, expected }) => ({
			requestId,
			expectedAccount: account,
			expectedPullRequestId: expected.kind === "pull-request" ? expected.pullRequestId : null,
		}))
	const comparison = compareAttributionAccuracy(report.requests, labels)
	problems.push(
		...comparison.problems.filter(
			(problem) => problem.kind !== "duplicate-label" && problem.kind !== "conflicting-labels",
		),
	)
	for (const [requestId, group] of grouped) {
		if (group.length < 2) continue
		const first = group[0]
		const identical = group.every(
			(entry) =>
				entry.nanos === first.nanos &&
				JSON.stringify(entry.expected) === JSON.stringify(first.expected) &&
				(entry.account && first.account
					? sameWorkAccount(entry.account, first.account)
					: entry.account === first.account),
		)
		problems.push({
			kind: identical ? "duplicate-label" : "conflicting-labels",
			requestId,
			detail: "repeated reference entries are excluded from scoring",
		})
	}

	// Weight assignment quality by independent receipts, while keeping observed coverage unchanged.
	const weighted = compareAttributionAccuracy(
		report.requests.map((row) => {
			if (!object(row)) return row
			const nanos = unique.get(row.requestId)?.nanos
			return nanos !== undefined && row.priceStatus === "priced"
				? { ...row, knownCostUsd: usd(nanos), totalCostUsd: usd(nanos) }
				: row
		}),
		labels,
	)
	comparison.metrics = weighted.metrics

	const rows = new Map<string, RequestCostAllocation>()
	const repeatedRows = new Set<string>()
	for (const row of report.requests) {
		if (!object(row) || typeof row.requestId !== "string") continue
		if (rows.has(row.requestId) || repeatedRows.has(row.requestId)) {
			rows.delete(row.requestId)
			repeatedRows.add(row.requestId)
		} else rows.set(row.requestId, row)
	}

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

	// Candidate lists reconcile the report's bookkeeping, never supply human ownership labels.
	const inferredPRs = new Map<string, PullIdentity & { requestIds: string[] }>()
	const inferredTotal = expectedUnallocated.get("inferred")
	for (const row of rows.values()) {
		if (row.allocation !== "inferred") continue
		const nanos = decimalNanos(row.knownCostUsd)
		if (inferredTotal) {
			inferredTotal.requestIds.push(row.requestId)
			inferredTotal.nanos += nanos ?? 0n
			inferredTotal.priced &&= row.priceStatus === "priced" && nanos !== undefined
		}
		if (
			!identifiers(row.pullRequestIds) ||
			!row.pullRequestIds.length ||
			!row.pullRequestIds.every((key) => PR_KEY.test(key))
		) {
			problems.push({
				kind: "invalid-report-row",
				requestId: row.requestId,
				detail: "inferred request needs complete, unique candidate PR keys",
			})
			continue
		}
		if (!isAccuracyAccount(row.account)) continue
		for (const key of row.pullRequestIds) {
			const id = groupKey(key, row.account)
			const group = inferredPRs.get(id) ?? { key, account: row.account, requestIds: [] }
			group.requestIds.push(row.requestId)
			inferredPRs.set(id, group)
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
				!PR_KEY.test(entry.key) ||
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
	for (const id of [...new Set([...expectedPRs.keys(), ...observedPRs.keys(), ...inferredPRs.keys()])].sort()) {
		const expected = expectedPRs.get(id) ?? empty()
		const actual = observedPRs.get(id)
		const identity = expectedPRs.get(id) ?? actual ?? inferredPRs.get(id)
		if (!identity) continue
		const { key, account } = identity
		const inferredIds = inferredPRs.get(id)?.requestIds ?? []
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
