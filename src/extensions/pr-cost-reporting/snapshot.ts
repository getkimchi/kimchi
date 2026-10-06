import { isWorkId } from "../../shared/work-id.js"
import type { PullRequestCostReport, RequestCostAllocation } from "../work-attribution/costs.js"
import { isWorkScope, sameWorkAccount, type WorkAccount } from "../work-attribution/scope.js"
import type { WorkRecord } from "../work-attribution/summary.js"

export interface ReportingRepository {
	provider: "github" | "gitlab"
	host: string
	id: string
	name?: string
}
export interface SnapshotContent {
	repository: ReportingRepository
	pullRequests: { id: string; number: number; url: string; state: "open" | "closed" | "merged"; mergedAt?: string }[]
	requests: {
		requestId: string
		billingRecordIds: string[]
		startedAt: string
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
export function validTime(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
		Number(value.slice(0, 4)) < 1 ||
		!Number.isFinite(Date.parse(value))
	)
		return false
	const day = value.slice(0, 10)
	return new Date(`${day}T00:00:00Z`).toISOString().startsWith(day)
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
	const host = new URL(`https://${repo.host}`)
	if (
		!onlyKeys(repo, ["provider", "host", "id", "name"]) ||
		!onlyKeys(coverage, ["observedRequests", "unpricedRequests", "historyComplete", "lastCostRefreshAt"])
	)
		fail()
	if (
		host.host !== repo.host ||
		host.pathname !== "/" ||
		host.username ||
		host.password ||
		host.search ||
		host.hash ||
		(repo.name !== undefined && (typeof repo.name !== "string" || repo.name.length > 256))
	)
		fail()
	const pulls = new Set<string>()
	for (const pr of pullRequests) {
		if (!onlyKeys(pr, ["id", "number", "url", "state", "mergedAt"])) fail()
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
			(pr.mergedAt !== undefined && !validTime(pr.mergedAt))
		)
			fail()
		const url = new URL(pr.url)
		if (url.protocol !== "https:" || url.host !== repo.host || url.username || url.password || url.search || url.hash)
			fail()
		pulls.add(pr.id)
	}
	const seen = new Set<string>()
	for (const request of requests) {
		const allocation = request.allocation
		if (
			!onlyKeys(request, ["requestId", "billingRecordIds", "startedAt", "allocation"]) ||
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
		const count = allocation.pullRequestIds.length
		if (
			["pull-request", "unmerged", "post-merge"].includes(allocation.kind)
				? count !== 1
				: allocation.kind === "shared"
					? count < 2
					: !["unknown", "unlinked"].includes(allocation.kind) || count !== 0
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
			return evidence && typeof evidence === "object" && "source" in evidence && evidence.source === "work-command"
		})
			? "user-correction"
			: "explicit"
	if (request.allocation === "inferred") return request.segment?.attribution === "inferred" ? "model" : "session"
	if (request.segment?.attribution === "session" && request.allocation !== "pull-request") return "session"
	if (request.segment?.attribution === "explicit") return "explicit"
	return "native"
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
	const conflicts = new Set<string>()
	for (const row of records) {
		if (row.type === "request" && typeof row.requestId === "string")
			original.set(row.requestId, [...(original.get(row.requestId) ?? []), row])
		if (row.type === "work_link" && typeof row.linkId === "string" && typeof row.revision === "number") {
			const previous = links.get(row.linkId)
			if (!previous || Number(previous.revision) < row.revision) links.set(row.linkId, row)
		}
	}
	for (const request of report.requests) {
		if (!request.account || !isWorkId(request.requestId) || !request.startedAt) {
			incomplete = true
			skippedRequests++
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
				allocation: {
					kind,
					pullRequestIds: kind === "unknown" || kind === "unlinked" ? [] : [...new Set(pullRequestIds)].sort(),
					method: method(request, links),
				},
			})
			group.content.coverage.observedRequests++
			const refreshed = billingAccountVerified ? costRefreshes.get(request.requestId) : undefined
			if (
				refreshed &&
				(!group.content.coverage.lastCostRefreshAt ||
					Date.parse(refreshed) > Date.parse(group.content.coverage.lastCostRefreshAt))
			)
				group.content.coverage.lastCostRefreshAt = refreshed
			if (request.priceStatus !== "priced" || !bills.length) group.content.coverage.unpricedRequests++
		}
	}
	const snapshots = [...groups.entries()]
		.filter(([key]) => !conflicts.has(key))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, group]) => {
			group.content.requests.sort((a, b) => a.requestId.localeCompare(b.requestId))
			group.content.pullRequests.sort((a, b) => a.id.localeCompare(b.id))
			if (incomplete) group.content.coverage.historyComplete = false
			return group
		})
	return { snapshots, incomplete, skippedRequests }
}
