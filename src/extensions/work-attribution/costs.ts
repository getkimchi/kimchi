import { plainURL } from "../../utils/url.js"
import { pullRequestKey } from "../pull-request-status/links.js"
import { providerId, repositoryPath, SHA } from "../pull-request-status/provider-records.js"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"
import { isWorkSegment, type WorkSegment } from "../work-attribution.js"
import { requestWorkLinks } from "./links.js"
import { isWorkAccount, sameWorkAccount, type WorkAccount } from "./scope.js"
import { object, SHA256_HEX, type WorkRecord } from "./summary.js"

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

function add(map: Map<string, Set<string>>, key: string, value: string): void {
	const values = map.get(key) ?? new Set<string>()
	values.add(value)
	map.set(key, values)
}

type PullIdentity = Required<Pick<WorkPullRequest, "provider" | "host" | "repository" | "number" | "url">> &
	Pick<WorkPullRequest, "id" | "repositoryId">

/** Keep a valid identity even when its provider metadata cannot yet establish a merge cutoff. */
function storedPullRequest(row: unknown): { identity: PullIdentity; pullRequest: WorkPullRequest | null } | undefined {
	if (!object(row)) return undefined
	const provider = row.provider ?? "github"
	if (
		(provider !== "github" && provider !== "gitlab") ||
		typeof row.host !== "string" ||
		typeof row.repository !== "string" ||
		typeof row.number !== "number" ||
		!Number.isSafeInteger(row.number) ||
		row.number < 1 ||
		typeof row.url !== "string" ||
		(row.id !== undefined && (typeof row.id !== "string" || !providerId(row.id))) ||
		(row.repositoryId !== undefined && (typeof row.repositoryId !== "string" || !providerId(row.repositoryId)))
	)
		return undefined
	const repository = provider === "github" ? row.repository.toLowerCase() : row.repository
	if (!repositoryPath(repository, provider)) return undefined
	const host = row.host.toLowerCase()
	const path = `/${repository}/${provider === "github" ? "pull" : "-/merge_requests"}/${row.number}`
	const url = plainURL(row.url)
	if (url?.host !== host || (provider === "github" ? url.pathname.toLowerCase() : url.pathname) !== path)
		return undefined
	const identity: PullIdentity = {
		provider,
		host,
		repository,
		number: row.number,
		url: `https://${host}${path}`,
		...(typeof row.id === "string" ? { id: row.id } : {}),
		...(typeof row.repositoryId === "string" ? { repositoryId: row.repositoryId } : {}),
	}
	if (
		(row.state !== "open" && row.state !== "closed" && row.state !== "merged") ||
		typeof row.checkedAt !== "string" ||
		time(row.checkedAt) === undefined ||
		(row.mergedAt !== null && (typeof row.mergedAt !== "string" || time(row.mergedAt) === undefined)) ||
		(row.state === "merged") !== (row.mergedAt !== null) ||
		(row.closedAt !== null && (typeof row.closedAt !== "string" || time(row.closedAt) === undefined)) ||
		typeof row.headSha !== "string" ||
		!SHA.test(row.headSha) ||
		(row.mergeCommitSha !== null && (typeof row.mergeCommitSha !== "string" || !SHA.test(row.mergeCommitSha)))
	)
		return { identity, pullRequest: null }
	return {
		identity,
		pullRequest: {
			...identity,
			state: row.state,
			headSha: row.headSha,
			mergeCommitSha: row.mergeCommitSha,
			mergedAt: row.mergedAt,
			closedAt: row.closedAt,
			checkedAt: row.checkedAt,
		},
	}
}

interface PullObservation {
	checkedAt: number
	pullRequest: WorkPullRequest | null
}

interface RequestOwnership {
	workIds: Set<string>
	sessionIds: Set<string>
	startedAt?: number
	segment?: WorkSegment
	unresolvedMatch?: boolean
	account?: WorkAccount
	unverifiedAccount?: boolean
}

function commitIdentity(row: WorkRecord): string | undefined {
	const fields = [row.workId, row.sessionId, row.repository, row.worktree, row.sha]
	if (fields.some((value) => typeof value !== "string" || !value) || typeof row.sha !== "string" || !SHA.test(row.sha))
		return undefined
	return JSON.stringify(fields)
}

/** Only immutable native mutation evidence can make a request exclusive to a PR. */
function transitionFingerprint(row: WorkRecord): string | undefined {
	const fields = [
		row.requestId,
		row.transitionId,
		row.toolCallId,
		row.workId,
		row.sessionId,
		row.repository,
		row.worktree,
		row.path,
	]
	if (fields.some((value) => typeof value !== "string" || !value)) return undefined
	if (row.baseline !== null && (typeof row.baseline !== "string" || !SHA.test(row.baseline))) return undefined
	const states = [row.baselineFile, row.before, row.after]
	if (
		row.after === null ||
		states.some(
			(state) =>
				state !== null &&
				(!object(state) ||
					typeof state.blob !== "string" ||
					!SHA.test(state.blob) ||
					(state.mode !== "100644" && state.mode !== "100755")),
		)
	)
		return undefined
	if (
		!object(row.cursor) ||
		typeof row.cursor.bytes !== "number" ||
		!Number.isSafeInteger(row.cursor.bytes) ||
		row.cursor.bytes < 0 ||
		typeof row.cursor.digest !== "string" ||
		!SHA256_HEX.test(row.cursor.digest)
	)
		return undefined
	return JSON.stringify([
		...fields,
		row.baseline,
		...states.map((state) => (object(state) ? [state.blob, state.mode] : null)),
		row.cursor.bytes,
		row.cursor.digest,
	])
}

function exclusiveRequestPulls(
	records: readonly WorkRecord[],
	ownership: Map<string, RequestOwnership>,
	commitPulls: Map<string, Set<string>>,
): Map<string, string> {
	const transitions = new Map<
		string,
		{
			row: WorkRecord
			fingerprint?: string
			invalid: boolean
			covered: boolean
			referenced: boolean
			pulls: Set<string>
		}
	>()
	const requestTransitions = new Map<string, Set<string>>()
	const requestCommitPulls = new Map<string, Set<string>>()
	const unresolvedRequests = new Set<string>()
	const unresolvedWorks = new Set<string>()
	const rewritten = new Set<string>()
	const observations: { requestId: string; row: WorkRecord }[] = []
	for (const row of records) {
		if (row.type === "file_observation" && typeof row.requestId === "string")
			observations.push({ requestId: row.requestId, row })
		if (row.type === "commit" && typeof row.rewrittenFrom === "string")
			rewritten.add(JSON.stringify([row.workId, row.repository, row.rewrittenFrom]))
		if (row.type !== "file_transition") continue
		if (typeof row.transitionId !== "string" || !row.transitionId) {
			if (typeof row.requestId === "string") unresolvedRequests.add(row.requestId)
			continue
		}
		if (typeof row.requestId === "string") add(requestTransitions, row.requestId, row.transitionId)
		const fingerprint = transitionFingerprint(row)
		const previous = transitions.get(row.transitionId)
		if (previous) {
			if (previous.fingerprint !== fingerprint) previous.fingerprint = undefined
			previous.invalid ||= previous.fingerprint === undefined
		} else
			transitions.set(row.transitionId, {
				row,
				fingerprint,
				invalid: fingerprint === undefined,
				covered: false,
				referenced: false,
				pulls: new Set(),
			})
	}
	// Tool windows can overlap human edits, so an observation never proves ownership. It blocks native proof only where
	// it could have altered that evidence: an incomplete or truncated scan, or a file natively edited in the same work and
	// worktree. A tool change to any other file, such as build output, leaves the proof alone.
	const nativePaths = new Set(
		[...transitions.values()].map(({ row }) => JSON.stringify([row.workId, row.worktree, row.path])),
	)
	for (const { requestId, row } of observations) {
		const files = Array.isArray(row.files) ? row.files : []
		if (
			row.complete !== true ||
			row.truncated === true ||
			files.some(
				(file) =>
					!object(file) ||
					typeof file.path !== "string" ||
					nativePaths.has(JSON.stringify([row.workId, row.worktree, file.path])),
			)
		)
			unresolvedRequests.add(requestId)
	}
	for (const row of records) {
		if (row.type !== "commit") continue
		const key = commitIdentity(row)
		if (typeof row.requestId === "string" && !rewritten.has(JSON.stringify([row.workId, row.repository, row.sha]))) {
			const links = key === undefined ? undefined : commitPulls.get(key)
			if (links?.size) for (const pull of links) add(requestCommitPulls, row.requestId, pull)
			else unresolvedRequests.add(row.requestId)
		}
		if (row.fileMatches === undefined && row.source !== "native-file-transition") continue
		if (!Array.isArray(row.fileMatches) || !row.fileMatches.length) {
			unresolvedWorks.add(row.workId)
			continue
		}
		for (const match of row.fileMatches) {
			if (!object(match) || !Array.isArray(match.transitionIds) || !match.transitionIds.length) {
				unresolvedWorks.add(row.workId)
				continue
			}

			const ids = match.transitionIds.filter((id): id is string => typeof id === "string" && Boolean(id))
			const evidence = ids.flatMap((id) => {
				const value = transitions.get(id)
				return value ? [value] : []
			})
			if (!evidence.length) unresolvedWorks.add(row.workId)
			const valid =
				key !== undefined &&
				row.source === "native-file-transition" &&
				ids.length === match.transitionIds.length &&
				evidence.length === ids.length &&
				(match.method === "file-chain" || match.method === "path-blob" || match.method === "file-hunks") &&
				match.worktree === row.worktree &&
				evidence.every(
					({ row: edit, fingerprint }) =>
						fingerprint !== undefined &&
						edit.workId === row.workId &&
						edit.sessionId === row.sessionId &&
						edit.repository === row.repository &&
						edit.worktree === row.worktree &&
						edit.path === match.path,
				)
			const links = key === undefined ? undefined : commitPulls.get(key)
			for (const value of evidence) {
				value.referenced = true
				// A rewrite names ancestry, not which native changes survived in the new commit.
				if (!valid || !links?.size || rewritten.has(JSON.stringify([row.workId, row.repository, row.sha]))) {
					value.invalid = true
					continue
				}
				value.covered ||= match.method === "file-chain"
				for (const pull of links) value.pulls.add(pull)
			}
		}
	}

	const exclusive = new Map<string, string>()
	// An edit no commit names, such as a scratch, ignored or reverted file, neither proves nor blocks a PR. While a
	// commit of its work is unmatched, the edit could be in it, so it still blocks.
	const neutral = new Set<string>()
	for (const [requestId, ids] of requestTransitions) {
		const owner = ownership.get(requestId)
		if (!owner || unresolvedRequests.has(requestId) || owner.workIds.size !== 1 || owner.sessionIds.size !== 1) continue
		const pulls = new Set<string>()
		let complete = true
		let proven = false
		for (const id of ids) {
			const value = transitions.get(id)
			if (
				value &&
				!value.invalid &&
				!value.referenced &&
				!unresolvedWorks.has(value.row.workId) &&
				owner.workIds.has(value.row.workId) &&
				owner.sessionIds.has(value.row.sessionId)
			)
				continue
			if (
				!value ||
				value.invalid ||
				!value.covered ||
				unresolvedWorks.has(value.row.workId) ||
				!owner.workIds.has(value.row.workId) ||
				!owner.sessionIds.has(value.row.sessionId)
			) {
				complete = false
				break
			}
			proven = true
			for (const pull of value.pulls) pulls.add(pull)
		}
		for (const pull of requestCommitPulls.get(requestId) ?? []) pulls.add(pull)
		if (!complete) continue
		// A tool commit names its PR but proves no edit of its own; the input still counts its PR below.
		if (!proven) neutral.add(requestId)
		else if (pulls.size === 1) for (const pull of pulls) exclusive.set(requestId, pull)
	}

	// One input can require several requests or local children before producing its edits.
	const inputs = new Map<string, { requests: string[]; pulls: Set<string>; complete: boolean }>()
	for (const [requestId, owner] of ownership) {
		if (!owner.segment || owner.workIds.size !== 1) continue
		const key = JSON.stringify([
			[...owner.workIds][0],
			owner.segment.id,
			owner.account?.apiUrl,
			owner.account?.organizationId,
			owner.account?.userId,
		])

		const input = inputs.get(key) ?? { requests: [], pulls: new Set<string>(), complete: true }
		input.requests.push(requestId)
		for (const pull of requestCommitPulls.get(requestId) ?? []) input.pulls.add(pull)
		if (requestTransitions.has(requestId) || unresolvedRequests.has(requestId)) {
			const pull = exclusive.get(requestId)
			if (pull) input.pulls.add(pull)
			else if (!neutral.has(requestId)) input.complete = false
		}
		inputs.set(key, input)
	}
	for (const input of inputs.values()) {
		const nativeEvidence = input.requests.some((requestId) => exclusive.has(requestId))
		for (const requestId of input.requests) {
			exclusive.delete(requestId)
			if (nativeEvidence && input.complete && input.pulls.size === 1)
				for (const pull of input.pulls) exclusive.set(requestId, pull)
		}
	}
	return exclusive
}

interface BillingRow {
	requestIds: Set<string>
	prices: Set<bigint>
	invalid: boolean
}

function requestPrices(observations: readonly RequestCostObservation[], noCharge: ReadonlyMap<string, WorkAccount>) {
	const billing = new Map<string, BillingRow>()
	const requestBilling = new Map<string, Set<string>>()
	const invalidRequests = new Set<string>()
	for (const row of observations) {
		if (typeof row.requestId !== "string" || !row.requestId) continue
		if (
			typeof row.billingRecordId !== "string" ||
			!row.billingRecordId ||
			row.billingRecordId.trim() !== row.billingRecordId
		) {
			invalidRequests.add(row.requestId)
			continue
		}
		add(requestBilling, row.requestId, row.billingRecordId)
		const value = billing.get(row.billingRecordId) ?? {
			requestIds: new Set<string>(),
			prices: new Set<bigint>(),
			invalid: false,
		}
		value.requestIds.add(row.requestId)
		if (row.costUsd !== null) {
			const nanos = decimalNanos(row.costUsd)
			if (nanos === undefined) value.invalid = true
			else value.prices.add(nanos)
		}
		billing.set(row.billingRecordId, value)
	}
	return (requestId: string) => {
		const billingRecordIds = [...(requestBilling.get(requestId) ?? [])].sort()
		let nanos = 0n
		let missing = billingRecordIds.length === 0 && !noCharge.has(requestId)
		let invalid = invalidRequests.has(requestId)
		let conflict = false
		for (const billingId of billingRecordIds) {
			const value = billing.get(billingId)
			if (!value) continue
			if (value.requestIds.size !== 1 || value.prices.size > 1) conflict = true
			else if (value.invalid) invalid = true
			else if (value.prices.size === 0) missing = true
			else for (const amount of value.prices) nanos += amount
		}

		const priceStatus: PriceStatus = conflict ? "conflict" : invalid ? "invalid" : missing ? "missing" : "priced"
		return { billingRecordIds, priceStatus, nanos }
	}
}

/** A request follows its own work; sharing a conversation does not share PR ownership. */
function allocation(
	owner: RequestOwnership,
	keys: string[],
	pulls: Map<string, PullObservation>,
	invalidWorkLinks: Set<string>,
): Pick<RequestCostAllocation, "allocation" | "reason"> {
	if (owner.workIds.size !== 1 || owner.sessionIds.size !== 1)
		return { allocation: "unknown", reason: "request-owner-conflict" }
	if ([...owner.workIds].some((workId) => invalidWorkLinks.has(workId)))
		return { allocation: "unknown", reason: "pull-request-invalid" }
	if (!keys.length) return { allocation: "unlinked" }
	const linked = keys.flatMap((key) => {
		const pull = pulls.get(key)?.pullRequest
		return pull ? [pull] : []
	})
	if (linked.length !== keys.length) return { allocation: "unknown", reason: "pull-request-conflict" }
	if (owner.startedAt === undefined) return { allocation: "unknown", reason: "request-time-missing" }
	const startedAt = owner.startedAt
	if (linked.every((pull) => pull.mergedAt && startedAt > Date.parse(pull.mergedAt)))
		return { allocation: "post-merge" }
	if (keys.length > 1) return { allocation: "shared" }
	return { allocation: linked[0].state === "merged" ? "pull-request" : "unmerged" }
}

/** Recompute from durable evidence so repeated syncs and late prices cannot accumulate twice. */
export function calculatePullRequestCosts(
	records: readonly WorkRecord[],
	observations: readonly RequestCostObservation[],
	incompleteRequestIds: ReadonlySet<string> = new Set(),
	noCharge: ReadonlyMap<string, WorkAccount> = new Map(),
): PullRequestCostReport {
	const ownership = new Map<string, RequestOwnership>()
	const workPulls = new Map<string, Set<string>>()
	const pullWorks = new Map<string, Set<string>>()
	const invalidWorkLinks = new Set<string>()
	const pulls = new Map<string, PullObservation>()
	const commitPulls = new Map<string, Set<string>>()
	const identitiesByUrl = new Map<string, Set<string>>()
	// When each work first recorded each commit; a rewritten commit counts from its original.
	const commitRecorded = new Map<string, number>()
	const commitOrigins = new Map<string, string>()
	for (const row of records) {
		if (row.type !== "commit") continue
		const commit = JSON.stringify([row.workId, row.repository, row.sha])
		const recordedAt = time(row.recordedAt)
		if (recordedAt !== undefined && recordedAt < (commitRecorded.get(commit) ?? Number.POSITIVE_INFINITY))
			commitRecorded.set(commit, recordedAt)
		if (typeof row.rewrittenFrom === "string")
			commitOrigins.set(commit, JSON.stringify([row.workId, row.repository, row.rewrittenFrom]))
		if (!Array.isArray(row.pullRequests)) continue
		for (const value of row.pullRequests) {
			const identity = storedPullRequest(value)?.identity
			if (identity?.id) add(identitiesByUrl, identity.url, pullRequestKey(identity))
		}
	}

	const firstRecorded = (commit: string) => {
		let earliest = commitRecorded.get(commit) ?? Number.POSITIVE_INFINITY
		const seen = new Set([commit])
		for (let origin = commitOrigins.get(commit); origin && !seen.has(origin); origin = commitOrigins.get(origin)) {
			seen.add(origin)
			earliest = Math.min(earliest, commitRecorded.get(origin) ?? Number.POSITIVE_INFINITY)
		}
		return earliest
	}

	/** Keyed by work and PR: when that work first recorded a commit linked to the PR. */
	const firstLinked = new Map<string, number>()
	for (const row of records) {
		if (row.type === "request" && typeof row.requestId === "string" && row.requestId) {
			const owner: RequestOwnership = ownership.get(row.requestId) ?? {
				workIds: new Set<string>(),
				sessionIds: new Set<string>(),
			}
			if (row.segment !== undefined) {
				let segment = isWorkSegment(row.segment) ? row.segment : undefined
				if (segment && row.purpose === "work-matching")
					segment = { ...segment, attribution: "session", reason: "work-matching" }
				owner.unresolvedMatch ||=
					!segment ||
					segment.attribution === "unknown" ||
					(owner.segment !== undefined && JSON.stringify(owner.segment) !== JSON.stringify(segment))
				owner.segment ??= segment
			}

			const account = object(row.scope) && isWorkAccount(row.scope.account) ? row.scope.account : undefined
			owner.unverifiedAccount ||= !account || (owner.account !== undefined && !sameWorkAccount(owner.account, account))
			owner.account ??= account
			owner.workIds.add(row.workId)
			owner.sessionIds.add(row.sessionId)
			const startedAt = time(row.startedAt) ?? time(row.recordedAt)
			if (startedAt !== undefined && (owner.startedAt === undefined || startedAt < owner.startedAt))
				owner.startedAt = startedAt
			ownership.set(row.requestId, owner)
		}
		if (row.type !== "commit" || row.pullRequests === undefined) continue
		if (!Array.isArray(row.pullRequests)) {
			invalidWorkLinks.add(row.workId)
			continue
		}
		for (const value of row.pullRequests) {
			const parsed = storedPullRequest(value)
			if (!parsed) {
				invalidWorkLinks.add(row.workId)
				continue
			}

			const { identity, pullRequest: pull } = parsed
			const aliases = identitiesByUrl.get(identity.url)
			const key = identity.id
				? pullRequestKey(identity)
				: aliases?.size === 1
					? [...aliases][0]
					: `${identity.provider}:${identity.host}/${identity.repository}#${identity.number}`
			const commitKey = commitIdentity(row)
			if (commitKey !== undefined) add(commitPulls, commitKey, key)
			add(workPulls, row.workId, key)
			add(pullWorks, key, row.workId)
			const linked = JSON.stringify([row.workId, key])
			const recordedAt = firstRecorded(JSON.stringify([row.workId, row.repository, row.sha]))
			if (recordedAt < (firstLinked.get(linked) ?? Number.POSITIVE_INFINITY)) firstLinked.set(linked, recordedAt)
			if (!pull) {
				if (!pulls.has(key)) pulls.set(key, { checkedAt: Number.NEGATIVE_INFINITY, pullRequest: null })
				continue
			}

			const checkedAt = Date.parse(pull.checkedAt)
			const previous = pulls.get(key)
			if (!previous || checkedAt > previous.checkedAt) pulls.set(key, { checkedAt, pullRequest: pull })
			else if (checkedAt === previous.checkedAt && previous.pullRequest) {
				const other = previous.pullRequest
				if (
					other.state !== pull.state ||
					time(other.mergedAt) !== time(pull.mergedAt) ||
					(other.id && pull.id && other.id !== pull.id) ||
					(other.repositoryId && pull.repositoryId && other.repositoryId !== pull.repositoryId)
				)
					previous.pullRequest = null
				// Equivalent cost evidence may still carry different display metadata. Keep output stable.
				else if (JSON.stringify(pull) < JSON.stringify(other)) previous.pullRequest = pull
			}
		}
	}
	/**
	 * A request that started before one candidate PR merged is not shared with a follow-up PR
	 * whose first linked commit in the request's works came after that merge.
	 */
	const followUpPulls = (keys: string[], startedAt: number | undefined, workIds: string[]) => {
		const followUps = new Set<string>()
		for (const merged of keys) {
			const mergedAt = time(pulls.get(merged)?.pullRequest?.mergedAt)
			if (mergedAt === undefined || startedAt === undefined || startedAt > mergedAt) continue
			for (const key of keys) {
				const linkedAt = Math.min(
					...workIds.map((workId) => firstLinked.get(JSON.stringify([workId, key])) ?? Number.POSITIVE_INFINITY),
				)
				if (key !== merged && Number.isFinite(linkedAt) && linkedAt > mergedAt) followUps.add(key)
			}
		}
		return followUps
	}

	const exclusivePulls = exclusiveRequestPulls(records, ownership, commitPulls)
	const links = requestWorkLinks(records)
	const priceFor = requestPrices(observations, noCharge)
	const billingAccounts = new Map<string, (WorkAccount | undefined)[]>()
	for (const [requestId, account] of noCharge) billingAccounts.set(requestId, [account])
	for (const row of observations) {
		const accounts = billingAccounts.get(row.requestId) ?? []
		accounts.push(row.account)
		billingAccounts.set(row.requestId, accounts)
	}

	const requests: RequestCostAllocation[] = [...ownership]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([requestId, owner]) => {
			const workIds = [...owner.workIds].sort()
			const link = links.get(requestId)
			const linkedWorkIds = link ? [...link.workIds].sort() : []
			const allocationWorks = link ? linkedWorkIds : workIds
			let pullRequestIds = [...new Set(allocationWorks.flatMap((workId) => [...(workPulls.get(workId) ?? [])]))].sort()
			if (link) for (const key of pullRequestIds) for (const workId of workIds) add(pullWorks, key, workId)
			let allocated = allocation(owner, pullRequestIds, pulls, invalidWorkLinks)
			const exclusive = link ? undefined : exclusivePulls.get(requestId)
			if (
				pullRequestIds.length > 1 &&
				allocated.allocation !== "unknown" &&
				exclusive &&
				pullRequestIds.includes(exclusive)
			) {
				pullRequestIds = [exclusive]
				allocated = allocation(owner, pullRequestIds, pulls, invalidWorkLinks)
			} else if (allocated.allocation === "shared") {
				// Without proof of one target, a request cannot add to a PR that had already merged when it started.
				const unmergedAtStart = pullRequestIds.filter((key) => {
					const mergedAt = pulls.get(key)?.pullRequest?.mergedAt
					return !mergedAt || owner.startedAt === undefined || owner.startedAt <= Date.parse(mergedAt)
				})
				if (unmergedAtStart.length < pullRequestIds.length) {
					pullRequestIds = unmergedAtStart
					allocated = allocation(owner, pullRequestIds, pulls, invalidWorkLinks)
				}

				const followUps = followUpPulls(pullRequestIds, owner.startedAt, allocationWorks)
				if (allocated.allocation === "shared" && followUps.size && followUps.size < pullRequestIds.length) {
					pullRequestIds = pullRequestIds.filter((key) => !followUps.has(key))
					allocated = allocation(owner, pullRequestIds, pulls, invalidWorkLinks)
					// Timing narrows the candidates but never confirms the remaining PR.
					if (allocated.allocation === "pull-request") allocated = { allocation: "inferred" }
				}
			}

			const postMerge = allocated.allocation === "post-merge"
			if (!postMerge && owner.unresolvedMatch && !exclusive && !link)
				allocated = { allocation: "unknown", reason: "work-match-unresolved" }
			else if (
				!postMerge &&
				(owner.segment?.attribution === "inferred" ||
					// A request without an input record has no evidence of its own, like a session match.
					((owner.segment === undefined || owner.segment.attribution === "session") &&
						allocated.allocation === "pull-request")) &&
				!exclusive &&
				!link &&
				// An open PR's spend stays unmerged whatever the matching evidence; it has no confirmed or inferred split yet.
				(allocated.allocation === "pull-request" || allocated.allocation === "shared")
			)
				allocated = { allocation: "inferred" }
			if (!postMerge && link && (link.unresolved || linkedWorkIds.some((workId) => invalidWorkLinks.has(workId))))
				allocated = { allocation: "unknown", reason: "work-link-unresolved" }
			const accounts = billingAccounts.get(requestId) ?? []
			const workAccount = owner.account
			const reason: RequestCostAllocation["reason"] =
				owner.unverifiedAccount || (workAccount && accounts.some((account) => !isWorkAccount(account)))
					? "work-account-unverified"
					: workAccount && accounts.some((account) => account && !sameWorkAccount(workAccount, account))
						? "work-account-mismatch"
						: undefined
			// Post-merge spend keeps its bucket, but a bill from another account is never its own.
			if (reason) allocated = postMerge ? { ...allocated, reason } : { allocation: "unknown", reason }
			const { nanos, ...price } = priceFor(requestId)
			if (incompleteRequestIds.has(requestId) && price.priceStatus === "priced") price.priceStatus = "missing"
			return {
				requestId,
				account: owner.unverifiedAccount ? null : (owner.account ?? null),
				...(owner.segment ? { segment: owner.segment } : {}),
				workIds,
				...(link ? { linkedWorkIds, linkIds: [...link.linkIds].sort() } : {}),
				sessionIds: [...owner.sessionIds].sort(),
				startedAt: owner.startedAt === undefined ? null : new Date(owner.startedAt).toISOString(),
				pullRequestIds,
				...allocated,
				...price,
				knownCostUsd: usd(nanos),
				totalCostUsd: price.priceStatus === "priced" ? usd(nanos) : null,
			}
		})
	const requestsByPull = new Map<string, RequestCostAllocation[]>()
	const accountsByWork = new Map<string, Map<string, WorkAccount | null>>()
	const accountKey = (account: WorkAccount | null) =>
		JSON.stringify(account && [account.apiUrl, account.organizationId, account.userId])
	for (const row of requests) {
		for (const workId of [...row.workIds, ...(row.linkedWorkIds ?? [])]) {
			const accounts = accountsByWork.get(workId) ?? new Map<string, WorkAccount | null>()
			accounts.set(accountKey(row.account), row.account)
			accountsByWork.set(workId, accounts)
		}
		for (const key of row.pullRequestIds) {
			const linked = requestsByPull.get(key) ?? []
			linked.push(row)
			requestsByPull.set(key, linked)
		}
	}

	const pullRequests = [...pulls]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.flatMap(([key, { pullRequest }]) => {
			const groups = new Map<string, { account: WorkAccount | null; workIds: Set<string> }>()
			for (const workId of pullWorks.get(key) ?? []) {
				for (const account of accountsByWork.get(workId)?.values() ?? [null]) {
					const id = accountKey(account)
					const group = groups.get(id) ?? { account, workIds: new Set<string>() }
					group.workIds.add(workId)
					groups.set(id, group)
				}
			}
			return [...groups]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([id, { account, workIds }]) => {
					const linked = (requestsByPull.get(key) ?? []).filter((row) => accountKey(row.account) === id)
					const sharedRequestIds = linked.filter((row) => row.allocation === "shared").map((row) => row.requestId)
					const inferredRequestIds = linked.filter((row) => row.allocation === "inferred").map((row) => row.requestId)
					const unknownRequestIds = linked.filter((row) => row.allocation === "unknown").map((row) => row.requestId)
					const assigned = linked.filter(
						(row) =>
							row.allocation === "pull-request" || (row.allocation === "inferred" && row.pullRequestIds.length === 1),
					)

					const confirmedRows = assigned.filter((row) => row.allocation === "pull-request")
					const inferredRows = assigned.filter((row) => row.allocation === "inferred")
					const cost = totalRequestCosts(assigned)
					return {
						key,
						account,
						pullRequest,
						workIds: [...workIds].sort(),
						...cost,
						explicit: totalRequestCosts(confirmedRows),
						inferred: totalRequestCosts(inferredRows),
						totalCostUsd:
							account &&
							pullRequest?.state === "merged" &&
							!sharedRequestIds.length &&
							inferredRequestIds.length === inferredRows.length &&
							!unknownRequestIds.length
								? cost.totalCostUsd
								: null,
						sharedRequestIds,
						inferredRequestIds,
						unknownRequestIds,
					}
				})
		})
	const bucket = (kind: Allocation) => totalRequestCosts(requests.filter((row) => row.allocation === kind))
	return {
		pullRequests,
		requests,
		unallocated: {
			inferred: bucket("inferred"),
			shared: bucket("shared"),
			unlinked: bucket("unlinked"),
			unmerged: bucket("unmerged"),
			"post-merge": bucket("post-merge"),
			unknown: bucket("unknown"),
		},
	}
}
