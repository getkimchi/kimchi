import { isIssueKey } from "../../shared/issue-keys.js"
import { isWorkId } from "../../shared/work-id.js"
import {
	type PullRequestCost,
	type PullRequestCostReport,
	type RequestCostAllocation,
	time,
} from "../work-attribution/costs.js"
import { requestWorkLinks } from "../work-attribution/links.js"
import { isWorkScope, sameWorkAccount, type WorkAccount } from "../work-attribution/scope.js"
import { object, type WorkRecord } from "../work-attribution/summary.js"

export interface ReportingRepository {
	provider: "github" | "gitlab"
	host: string
	id: string
	name?: string
}

/** A local repository's provider identity, or `unsupported` when it has none (no GitHub or GitLab remote, or gone). */
export type RepositoryIdentity = ReportingRepository | "unsupported"

interface CorrectionReceipt {
	id: string
	revision: number
	recordedAt: string
	source: "work-command" | "producer-confirmation"
}

interface Allocation {
	kind: "pull-request" | "shared" | "unlinked" | "unmerged" | "post-merge" | "unknown"
	pullRequestIds: string[]
	method: "native" | "explicit" | "user-correction" | "model" | "session"
}

const MAX_BILLING_IDS = 8

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

function method(request: RequestCostAllocation, links: Map<string, WorkRecord>): Allocation["method"] {
	// An inferred local assignment stays inferred on the server, whatever evidence its segment or a link carries.
	if (request.allocation === "inferred") return request.segment?.attribution === "inferred" ? "model" : "session"
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

export interface RequestAttribution {
	request: RequestCostAllocation
	candidates: PullRequestCost[]
	destinations: ReportingRepository[]
	missing: boolean
	method: Allocation["method"]
	correction?: CorrectionReceipt
	workIssueKeys: string[]
	billingAccountVerified: boolean
	billingRecordIds: string[]
}

/** Full local attribution of every request; events carry it without an upload window or size limit. */
export function requestAttributions(
	records: WorkRecord[],
	report: PullRequestCostReport,
	repositories: Map<string, RepositoryIdentity>,
): Map<string, RequestAttribution> {
	const original = new Map<string, WorkRecord[]>()
	const links = new Map<string, WorkRecord>()
	const conflictingLinkStatus = new Set<string>()
	for (const row of records) {
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

	const attributions = new Map<string, RequestAttribution>()
	for (const request of report.requests) {
		const account = request.account
		const candidates = report.pullRequests.filter(
			(pr) => account && pr.account && sameWorkAccount(pr.account, account) && request.pullRequestIds.includes(pr.key),
		)
		const destinations = new Map<string, ReportingRepository>()
		let missing = !account
		for (const candidate of candidates) {
			const pr = candidate.pullRequest
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
				if (!account || !isWorkScope(row.scope) || !sameWorkAccount(row.scope.account, account)) {
					missing = true
					continue
				}
				const repo = repositories.get(row.scope.repository)
				if (repo === "unsupported") continue
				if (repo) destinations.set(repositoryKey(repo), repo)
				else missing = true
			}

		let correction: CorrectionReceipt | undefined
		const proof = verified.get(request.requestId)
		if (proof && !proof.unresolved && ![...proof.linkIds].some((id) => conflictingLinkStatus.has(id))) {
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
			if (row && validTime(row.recordedAt)) {
				const evidence = row.evidence
				const manual = row.status === "revoked" || (object(evidence) && evidence.source === "work-command")
				correction = {
					id: String(row.linkId),
					revision: Number(row.revision),
					recordedAt: row.recordedAt,
					source: manual ? "work-command" : "producer-confirmation",
				}
			}
		}
		const workIssueKeys = new Set<string>()
		for (const row of original.get(request.requestId) ?? [])
			if (object(row.issue) && typeof row.issue.key === "string" && isIssueKey(row.issue.key))
				workIssueKeys.add(row.issue.key)
		const billingAccountVerified =
			request.reason !== "work-account-mismatch" && request.reason !== "work-account-unverified"
		attributions.set(request.requestId, {
			request,
			candidates,
			destinations: [...destinations.values()],
			missing,
			method: method(request, links),
			correction,
			workIssueKeys: [...workIssueKeys],
			billingAccountVerified,
			// Larger bill sets are resolved by the server through the request's exact billing tag.
			billingRecordIds:
				billingAccountVerified && request.billingRecordIds.length <= MAX_BILLING_IDS
					? [...request.billingRecordIds]
					: [],
		})
	}
	return attributions
}

export function allocationFor(attribution: RequestAttribution, pullRequestIds: string[]): Allocation {
	const { request, missing, destinations } = attribution
	let kind: Allocation["kind"] =
		request.allocation === "inferred" ? (pullRequestIds.length > 1 ? "shared" : "pull-request") : request.allocation
	// The backend applies each candidate's merge cutoff to a shared claim.
	if (kind === "post-merge" && pullRequestIds.length > 1) kind = "shared"
	if (
		missing ||
		destinations.length > 1 ||
		(kind !== "unlinked" && pullRequestIds.length !== request.pullRequestIds.length) ||
		(!pullRequestIds.length && kind !== "unlinked")
	)
		kind = "unknown"
	return {
		kind,
		pullRequestIds: kind === "unlinked" ? [] : [...new Set(pullRequestIds)].sort(),
		method: attribution.method,
	}
}
