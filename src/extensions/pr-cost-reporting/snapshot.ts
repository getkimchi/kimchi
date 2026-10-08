import { isWorkId } from "../../shared/work-id.js"
import { plainURL } from "../../utils/url.js"
import { type PullRequestCostReport, type RequestCostAllocation, time } from "../work-attribution/costs.js"
import { requestWorkLinks } from "../work-attribution/links.js"
import { isWorkScope, sameWorkAccount, type WorkAccount } from "../work-attribution/scope.js"
import { object, type WorkRecord } from "../work-attribution/summary.js"

export interface ReportingRepository {
	provider: "github" | "gitlab"
	host: string
	id: string
	name?: string
}
interface CorrectionReceipt {
	id: string
	revision: number
	recordedAt: string
	source: "work-command" | "producer-confirmation"
}
export interface SnapshotContent {
	repository: ReportingRepository
	windowedPullRequestIds?: string[]
	pullRequests: {
		id: string
		number: number
		url: string
		state: "open" | "closed" | "merged"
		mergedAt?: string
		closedAt?: string
	}[]
	requests: {
		requestId: string
		billingRecordIds: string[]
		startedAt: string
		correction?: CorrectionReceipt
		allocation: {
			kind: "pull-request" | "shared" | "unlinked" | "unmerged" | "post-merge" | "unknown"
			pullRequestIds: string[]
			method: "native" | "explicit" | "user-correction" | "model" | "session"
		}
	}[]
	coverage: { observedRequests: number; unpricedRequests: number; historyComplete: boolean; lastCostRefreshAt?: string }
}
export interface RepositorySnapshot {
	account: WorkAccount
	content: SnapshotContent
	/** Complete local inventory before windowing. Lets the queue distinguish expiry from lost evidence. */
	observedRequestIds?: string[]
	/** Missing provider evidence holds prior claims for this group; never enters the wire body. */
	incomplete?: boolean
}
export interface WireSnapshot extends SnapshotContent {
	schemaVersion: 1
	producerId: string
	revision: string
	generatedAt: string
}
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const UPLOAD_WINDOW_MS = 32 * 24 * 60 * 60 * 1000
const DETAIL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000
/** The server stops accepting corrections five minutes before a PR's details expire. */
const CORRECTION_MARGIN_MS = 5 * 60_000
const FINISHED_PR_GRACE_MS = 2 * 24 * 60 * 60 * 1000
export const MAX_REVISION = 9223372036854775807n
export function revision(value: unknown): value is string {
	return typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= MAX_REVISION
}
export function repositoryKey(repository: ReportingRepository): string {
	return JSON.stringify([repository.provider, repository.host, repository.id])
}
export function accountKey(account: WorkAccount): string {
	return JSON.stringify([account.apiUrl, account.organizationId, account.userId])
}
/** Protobuf timestamps start at year 1. */
export function validTime(value: unknown): value is string {
	return typeof value === "string" && Number(value.slice(0, 4)) >= 1 && time(value) !== undefined
}
function providerId(value: unknown): value is string {
	return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value)
}
function onlyKeys(value: object, allowed: string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key))
}

/** A final boundary check also applies to pending payloads recovered from disk. */
export function validateSnapshot(snapshot: WireSnapshot): void {
	const fail = () => {
		throw new Error("PR reporting snapshot is invalid or exceeds the upload limits")
	}
	const { repository: repo, pullRequests, requests, coverage } = snapshot
	if (
		!onlyKeys(snapshot, [
			"schemaVersion",
			"producerId",
			"revision",
			"generatedAt",
			"repository",
			"pullRequests",
			"requests",
			"coverage",
			"windowedPullRequestIds",
		])
	)
		fail()
	if (
		snapshot.schemaVersion !== 1 ||
		!isWorkId(snapshot.producerId) ||
		!revision(snapshot.revision) ||
		!validTime(snapshot.generatedAt) ||
		!repo ||
		!["github", "gitlab"].includes(repo.provider) ||
		!providerId(repo.id) ||
		typeof repo.host !== "string" ||
		repo.host.length > 253 ||
		!Array.isArray(pullRequests) ||
		!Array.isArray(requests) ||
		requests.length > 10000 ||
		pullRequests.length > 100 ||
		!coverage ||
		coverage.observedRequests !== requests.length ||
		!Number.isSafeInteger(coverage.unpricedRequests) ||
		coverage.unpricedRequests < 0 ||
		coverage.unpricedRequests > requests.length ||
		typeof coverage.historyComplete !== "boolean" ||
		(coverage.lastCostRefreshAt !== undefined && !validTime(coverage.lastCostRefreshAt))
	)
		fail()
	const host = plainURL(`https://${repo.host}`)
	if (
		!onlyKeys(repo, ["provider", "host", "id", "name"]) ||
		!onlyKeys(coverage, ["observedRequests", "unpricedRequests", "historyComplete", "lastCostRefreshAt"])
	)
		fail()
	if (
		host?.host !== repo.host ||
		host.pathname !== "/" ||
		(repo.name !== undefined && (typeof repo.name !== "string" || repo.name.length > 256))
	)
		fail()
	const pulls = new Set<string>()
	for (const pr of pullRequests) {
		if (!onlyKeys(pr, ["id", "number", "url", "state", "mergedAt", "closedAt"])) fail()
		if (
			!providerId(pr.id) ||
			pulls.has(pr.id) ||
			!Number.isSafeInteger(pr.number) ||
			pr.number < 1 ||
			pr.number > 2147483647 ||
			!["open", "closed", "merged"].includes(pr.state) ||
			typeof pr.url !== "string" ||
			pr.url.length > 2048 ||
			(pr.state === "merged") !== (pr.mergedAt !== undefined) ||
			(pr.mergedAt !== undefined && !validTime(pr.mergedAt)) ||
			(pr.closedAt !== undefined && (pr.state !== "closed" || !validTime(pr.closedAt)))
		)
			fail()
		if (plainURL(pr.url)?.host !== repo.host) fail()
		pulls.add(pr.id)
	}
	const windowed = snapshot.windowedPullRequestIds
	if (
		windowed !== undefined &&
		(!Array.isArray(windowed) ||
			windowed.length > 2000 ||
			new Set(windowed).size !== windowed.length ||
			windowed.some((id) => !providerId(id) || pulls.has(id)))
	)
		fail()
	const seen = new Set<string>()
	for (const request of requests) {
		const allocation = request.allocation
		if (
			!onlyKeys(request, ["requestId", "billingRecordIds", "startedAt", "allocation", "correction"]) ||
			!allocation ||
			!onlyKeys(allocation, ["kind", "pullRequestIds", "method"])
		)
			fail()
		if (
			!isWorkId(request.requestId) ||
			seen.has(request.requestId) ||
			!validTime(request.startedAt) ||
			!Array.isArray(request.billingRecordIds) ||
			request.billingRecordIds.length > 8 ||
			request.billingRecordIds.some((id) => !isWorkId(id)) ||
			new Set(request.billingRecordIds).size !== request.billingRecordIds.length ||
			!allocation ||
			!["native", "explicit", "user-correction", "model", "session"].includes(allocation.method) ||
			!Array.isArray(allocation.pullRequestIds) ||
			new Set(allocation.pullRequestIds).size !== allocation.pullRequestIds.length ||
			allocation.pullRequestIds.some((id) => !pulls.has(id))
		)
			fail()
		const correction = request.correction
		if (
			correction !== undefined &&
			(!correction ||
				!onlyKeys(correction, ["id", "revision", "recordedAt", "source"]) ||
				!isWorkId(correction.id) ||
				!Number.isSafeInteger(correction.revision) ||
				correction.revision < 1 ||
				correction.revision > 2147483647 ||
				!validTime(correction.recordedAt) ||
				!["work-command", "producer-confirmation"].includes(correction.source))
		)
			fail()
		const count = allocation.pullRequestIds.length
		if (
			["pull-request", "unmerged", "post-merge"].includes(allocation.kind)
				? count !== 1
				: allocation.kind === "shared"
					? count < 2
					: allocation.kind === "unlinked"
						? count !== 0
						: allocation.kind !== "unknown"
		)
			fail()
		seen.add(request.requestId)
	}
	if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) fail()
}

function method(
	request: RequestCostAllocation,
	links: Map<string, WorkRecord>,
): SnapshotContent["requests"][number]["allocation"]["method"] {
	if (request.linkIds?.length)
		return request.linkIds.some((id) => {
			const evidence = links.get(id)?.evidence
			return object(evidence) && evidence.source === "work-command"
		})
			? "user-correction"
			: "explicit"
	if (request.segment?.attribution === "explicit") return "explicit"
	// Only a confirmed PR allocation rests on recorded evidence; anything else is a model guess or session grouping.
	if (request.allocation === "pull-request") return "native"
	return request.segment?.attribution === "inferred" ? "model" : "session"
}

/** Construct fields individually: local identities, paths, prompts and prices never cross this boundary. */
export function buildSnapshots(
	records: WorkRecord[],
	report: PullRequestCostReport,
	repositories: Map<string, ReportingRepository>,
	historyComplete: boolean,
	costRefreshes = new Map<string, string>(),
): { snapshots: RepositorySnapshot[]; incomplete: boolean; skippedRequests: number } {
	const groups = new Map<string, RepositorySnapshot>()
	let incomplete = !historyComplete
	let skippedRequests = 0
	const original = new Map<string, WorkRecord[]>()
	const links = new Map<string, WorkRecord>()
	const conflictingLinkStatus = new Set<string>()
	const conflicts = new Set<string>()
	const cutoff = Date.now() - UPLOAD_WINDOW_MS
	// Works with repository evidence. Questions asked outside Git have neither scope nor commits.
	const repositoryWorks = new Set<string>()
	for (const row of records) {
		if ((row.type === "request" && isWorkScope(row.scope)) || row.type === "commit")
			repositoryWorks.add(String(row.workId))
		if (row.type === "request" && typeof row.requestId === "string")
			original.set(row.requestId, [...(original.get(row.requestId) ?? []), row])
		if (row.type === "work_link" && typeof row.linkId === "string" && typeof row.revision === "number") {
			const previous = links.get(row.linkId)
			if (!previous || Number(previous.revision) < row.revision) {
				links.set(row.linkId, row)
				conflictingLinkStatus.delete(row.linkId)
			} else if (previous.revision === row.revision && previous.status !== row.status) {
				conflictingLinkStatus.add(row.linkId)
			}
		}
	}
	// Reuse the native proof validator. Revocations are explicit user decisions;
	// validate their original scope and evidence before sending the receipt.
	const verified = requestWorkLinks(
		records.map((row) => (row.type === "work_link" && row.status === "revoked" ? { ...row, status: "active" } : row)),
	)
	const byRequest = new Map(report.requests.map((request) => [request.requestId, request]))
	const corrections = new Map<string, CorrectionReceipt>()
	for (const request of report.requests) {
		const proof = verified.get(request.requestId)
		if (!proof || proof.unresolved || [...proof.linkIds].some((id) => conflictingLinkStatus.has(id))) continue
		const rows = [...proof.linkIds]
			.flatMap((id) => {
				const row = links.get(id)
				return row ? [row] : []
			})
			.filter((row) => isWorkId(row.linkId) && Number.isSafeInteger(row.revision) && validTime(row.recordedAt))
			.sort(
				(a, b) =>
					Date.parse(String(b.recordedAt)) - Date.parse(String(a.recordedAt)) ||
					Number(b.revision) - Number(a.revision),
			)
		const row = rows[0]
		if (!row || !validTime(row.recordedAt)) continue
		// A correction for PRs whose details the server is about to delete can no longer apply.
		const account = request.account
		const candidates = report.pullRequests.filter(
			(pr) => account && pr.account && sameWorkAccount(pr.account, account) && request.pullRequestIds.includes(pr.key),
		)
		if (
			candidates.length &&
			candidates.every((pr) => {
				const finished = pr.pullRequest?.state === "merged" ? pr.pullRequest.mergedAt : pr.pullRequest?.closedAt
				return finished && Date.now() >= Date.parse(finished) + DETAIL_WINDOW_MS - CORRECTION_MARGIN_MS
			})
		)
			continue
		const evidence = row.evidence
		const manual = row.status === "revoked" || (object(evidence) && evidence.source === "work-command")
		corrections.set(request.requestId, {
			id: String(row.linkId),
			revision: Number(row.revision),
			recordedAt: row.recordedAt,
			source: manual ? "work-command" : "producer-confirmation",
		})
	}
	// Send recent attempts, attempts of open or recently finished PRs and corrections the server can still apply.
	// Older finished history stays on the server through exact windowed PR IDs, so long-lived works stay small.
	const recentPulls = new Set(
		report.pullRequests
			.filter((pr) => {
				const finishedAt = pr.pullRequest?.state === "merged" ? pr.pullRequest.mergedAt : pr.pullRequest?.closedAt
				return !finishedAt || Date.parse(finishedAt) >= cutoff - FINISHED_PR_GRACE_MS
			})
			.map((pr) => pr.key),
	)
	const current = (request: RequestCostAllocation) =>
		!request.startedAt ||
		Date.parse(request.startedAt) >= cutoff ||
		request.pullRequestIds.some((key) => recentPulls.has(key))
	const included = new Set(
		report.requests
			.filter((request) => {
				const account = request.account
				const receipt = corrections.get(request.requestId)
				if (!account) return false
				if (current(request)) return true
				return (
					receipt !== undefined &&
					report.pullRequests.some((pr) => {
						if (!pr.account || !sameWorkAccount(pr.account, account) || !request.pullRequestIds.includes(pr.key))
							return false
						const finished = pr.pullRequest?.state === "merged" ? pr.pullRequest.mergedAt : pr.pullRequest?.closedAt
						return (
							finished !== null &&
							finished !== undefined &&
							Date.now() < Date.parse(finished) + DETAIL_WINDOW_MS - CORRECTION_MARGIN_MS &&
							(Date.parse(receipt.recordedAt) >= cutoff ||
								Date.parse(receipt.recordedAt) >= Date.parse(finished) + UPLOAD_WINDOW_MS)
						)
					})
				)
			})
			.map((request) => request.requestId),
	)
	const unpriced = new Set(
		report.requests.filter((request) => request.priceStatus !== "priced").map((request) => request.requestId),
	)
	// A verified no-charge attempt is priced at zero and has no billing records to send.
	const noCharge = new Set(
		report.requests
			.filter((request) => request.priceStatus === "priced" && !request.billingRecordIds.length)
			.map((request) => request.requestId),
	)
	for (const request of report.requests) {
		if (!request.account || !isWorkId(request.requestId) || !request.startedAt) {
			// Unscoped attempts of repository work that would be sent leave its history incomplete.
			// Questions asked outside Git and older history never count.
			if (
				current(request) &&
				[...request.workIds, ...(request.linkedWorkIds ?? [])].some((workId) => repositoryWorks.has(workId))
			) {
				incomplete = true
				skippedRequests++
			}
			continue
		}
		const account = request.account
		const candidates = report.pullRequests.filter(
			(pr) => pr.account && sameWorkAccount(pr.account, account) && request.pullRequestIds.includes(pr.key),
		)
		const destinations = new Map<string, ReportingRepository>()
		let missing = false
		for (const candidate of candidates) {
			const pr = candidate.pullRequest
			// Missing merge metadata leaves this request unknown; its repository can still report.
			if (!pr) continue
			if (!pr.id || !pr.repositoryId) {
				missing = true
				continue
			}
			const repo: ReportingRepository = {
				provider: pr.provider ?? "github",
				host: pr.host,
				id: pr.repositoryId,
				name: pr.repository,
			}
			destinations.set(repositoryKey(repo), repo)
		}
		if (!destinations.size || missing)
			for (const row of original.get(request.requestId) ?? []) {
				if (!isWorkScope(row.scope) || !sameWorkAccount(row.scope.account, account)) {
					missing = true
					continue
				}
				const repo = repositories.get(row.scope.repository)
				if (repo) destinations.set(repositoryKey(repo), repo)
				else missing = true
			}
		if (!destinations.size) {
			incomplete = true
			skippedRequests++
			continue
		}
		if (missing) incomplete = true
		for (const [repoKey, repo] of destinations) {
			const key = `${accountKey(account)}:${repoKey}`
			let group = groups.get(key)
			if (!group) {
				group = {
					account,
					content: {
						repository: repo,
						pullRequests: [],
						requests: [],
						coverage: { observedRequests: 0, unpricedRequests: 0, historyComplete },
					},
				}
				groups.set(key, group)
			}
			if (missing) group.incomplete = true
			const pullRequestIds: string[] = []
			for (const candidate of candidates) {
				const pr = candidate.pullRequest
				if (
					!pr?.id ||
					pr.repositoryId !== repo.id ||
					pr.host !== repo.host ||
					(pr.provider ?? "github") !== repo.provider
				)
					continue
				const metadata = {
					id: pr.id,
					number: pr.number,
					url: pr.url,
					state: pr.state,
					...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
					...(pr.state === "closed" && pr.closedAt ? { closedAt: pr.closedAt } : {}),
				}
				const existing = group.content.pullRequests.find((other) => other.id === pr.id)
				if (existing && JSON.stringify(existing) !== JSON.stringify(metadata)) {
					conflicts.add(key)
					incomplete = true
				}
				if (!existing) group.content.pullRequests.push(metadata)
				pullRequestIds.push(pr.id)
			}
			let kind: SnapshotContent["requests"][number]["allocation"]["kind"] =
				request.allocation === "inferred" ? (pullRequestIds.length > 1 ? "shared" : "pull-request") : request.allocation
			// The backend applies each candidate's merge cutoff to a shared claim.
			if (kind === "post-merge" && pullRequestIds.length > 1) kind = "shared"
			if (
				missing ||
				destinations.size > 1 ||
				(kind !== "unlinked" && pullRequestIds.length !== request.pullRequestIds.length) ||
				(!pullRequestIds.length && kind !== "unlinked")
			)
				kind = "unknown"
			const billingAccountVerified =
				request.reason !== "work-account-mismatch" && request.reason !== "work-account-unverified"
			const bills = billingAccountVerified ? [...request.billingRecordIds] : []
			group.content.requests.push({
				requestId: request.requestId,
				billingRecordIds: bills,
				startedAt: request.startedAt,
				...(corrections.has(request.requestId) ? { correction: corrections.get(request.requestId) } : {}),
				allocation: {
					kind,
					pullRequestIds: kind === "unlinked" ? [] : [...new Set(pullRequestIds)].sort(),
					method: method(request, links),
				},
			})
			const refreshed = billingAccountVerified ? costRefreshes.get(request.requestId) : undefined
			if (
				refreshed &&
				(!group.content.coverage.lastCostRefreshAt ||
					Date.parse(refreshed) > Date.parse(group.content.coverage.lastCostRefreshAt))
			)
				group.content.coverage.lastCostRefreshAt = refreshed
		}
	}
	const snapshots = [...groups.entries()]
		.filter(([key]) => !conflicts.has(key))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, group]) => {
			group.observedRequestIds = group.content.requests.map((request) => request.requestId).sort()
			const retained = group.content.requests.filter((request) => included.has(request.requestId))
			const pulls = new Set(retained.flatMap((request) => request.allocation.pullRequestIds))
			// Revocations have no exclusive PR claim, but retain the affected PR's metadata.
			for (const request of retained)
				if (request.correction) {
					const source = byRequest.get(request.requestId)
					for (const pr of report.pullRequests)
						if (pr.pullRequest?.id && source?.pullRequestIds.includes(pr.key)) pulls.add(pr.pullRequest.id)
				}
			const omitted: string[] = []
			group.content.requests = retained
			group.content.pullRequests = group.content.pullRequests.filter((pr) => {
				const finishedAt = pr.state === "merged" ? pr.mergedAt : pr.closedAt
				const keep = pulls.has(pr.id) || !finishedAt || Date.parse(finishedAt) >= cutoff - FINISHED_PR_GRACE_MS
				if (!keep && finishedAt && Date.now() < Date.parse(finishedAt) + DETAIL_WINDOW_MS) omitted.push(pr.id)
				return keep
			})
			if (omitted.length) group.content.windowedPullRequestIds = omitted.sort()
			group.content.coverage.observedRequests = retained.length
			group.content.coverage.unpricedRequests = retained.filter(
				(request) =>
					unpriced.has(request.requestId) || (!request.billingRecordIds.length && !noCharge.has(request.requestId)),
			).length
			if (!retained.length) group.content.coverage.lastCostRefreshAt = undefined
			group.content.requests.sort((a, b) => a.requestId.localeCompare(b.requestId))
			group.content.pullRequests.sort((a, b) => a.id.localeCompare(b.id))
			if (incomplete) group.content.coverage.historyComplete = false
			return group
		})
	return { snapshots, incomplete, skippedRequests }
}
