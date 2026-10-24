import { isWorkId } from "../../shared/work-id.js"
import { pullRequestAuthor, pullRequestTitle } from "../pull-request-status/provider-records.js"
import type { PullRequestCostReport } from "../work-attribution/costs.js"
import { isWorkScope, sameWorkAccount, sameWorkScope, type WorkAccount } from "../work-attribution/scope.js"
import type { WorkRecord } from "../work-attribution/summary.js"
import type { Fact } from "./ledger/outbox.js"
import type { StoredRecord } from "./ledger/records.js"
import { nativeObservations } from "./native.js"
import { type Event, type IssueKey, stableID, timeNanos, type Usage } from "./protocol.js"
import {
	accountKey,
	allocationFor,
	type RepositoryIdentity,
	repositoryKey,
	requestAttributions,
	validTime,
} from "./snapshot.js"

export interface CommonEvents {
	accounts: { account: WorkAccount; facts: Fact[]; recordHashes: string[] }[]
	unresolved: { requestId: string; reason: string; recordHashes: string[] }[]
}

export function buildEvents(
	stored: readonly StoredRecord[],
	report: PullRequestCostReport,
	repositories: Map<string, RepositoryIdentity>,
	producerId: string,
	check: () => void,
	existingClaim: (account: string, entity: string) => Event | undefined,
): CommonEvents {
	const records = stored.map((row) => {
		check()
		return JSON.parse(row.body) as WorkRecord
	})
	const native = nativeObservations(stored)
	const observations = new Map(native.observations.map((row) => [row.requestId, row]))
	const nativeProblems = new Map(native.unresolved.map((row) => [row.requestId, row]))
	const attribution = requestAttributions(records, report, repositories)
	const requests = new Map<string, { row: WorkRecord; hash: string }[]>()
	for (let i = 0; i < records.length; i++) {
		check()
		const row = records[i]
		if (row.type !== "request" && row.type !== "request_dispatch" && row.type !== "request_response") continue
		if (typeof row.requestId !== "string") continue
		const group = requests.get(row.requestId) ?? []
		group.push({ row, hash: stored[i].recordHash })
		requests.set(row.requestId, group)
	}
	const accounts = new Map<string, { account: WorkAccount; facts: Map<string, Fact>; recordHashes: Set<string> }>()
	const unresolved: CommonEvents["unresolved"] = []
	for (const [requestId, evidence] of attribution) {
		check()
		const source = requests.get(requestId) ?? []
		const recordHashes = [...new Set(source.map(({ hash }) => hash))]
		try {
			const row = source.find(({ row }) => row.type === "request")?.row
			if (
				!isWorkId(requestId) ||
				!row ||
				!isWorkId(row.workId) ||
				!row.sessionId ||
				!isWorkScope(row.scope) ||
				!validTime(row.startedAt)
			)
				throw new Error("missing_request_identity")
			const scope = row.scope
			if (!evidence.request.account || !sameWorkAccount(scope.account, evidence.request.account))
				throw new Error("conflicting_request_account")
			for (const { row: other } of source) {
				check()
				if (other.version !== 1 || other.workId !== row.workId || other.sessionId !== row.sessionId)
					throw new Error("conflicting_request_owner")
				if (
					other.type === "request" &&
					(!isWorkScope(other.scope) ||
						!sameWorkScope(scope, other.scope) ||
						!validTime(other.startedAt) ||
						timeNanos(other.startedAt) !== timeNanos(row.startedAt))
				)
					throw new Error("conflicting_request_identity")
			}
			const dispatches = source.filter(({ row }) => row.type === "request_dispatch")
			for (const { row: dispatch } of dispatches)
				if (
					!validTime(dispatch.startedAt) ||
					timeNanos(dispatch.startedAt) !== timeNanos(row.startedAt) ||
					!validTime(dispatch.dispatchedAt)
				)
					throw new Error("conflicting_dispatch")
			const observed = observations.get(requestId)
			if (
				!observed &&
				!dispatches.length &&
				!(evidence.billingAccountVerified && evidence.request.billingRecordIds.length)
			)
				continue
			const identity = repositories.get(scope.repository)
			if (!identity) throw new Error("repository_unresolved")
			const key = accountKey(scope.account)
			const entityId = stableID("kimchi", "request", key, producerId, requestId.toLowerCase())
			const previous = existingClaim(key, entityId)
			const repository = previous ? previous.repository : identity === "unsupported" ? undefined : identity
			const group = accounts.get(key) ?? {
				account: scope.account,
				facts: new Map<string, Fact>(),
				recordHashes: new Set<string>(),
			}
			accounts.set(key, group)
			const common = {
				source: "kimchi",
				sourceVersion: observed?.sourceVersion ?? "unknown",
				deviceId: producerId,
				workId: row.workId,
				sessionId: row.sessionId,
				observeTime: observed?.observeTime ?? row.startedAt,
				repository,
			}
			const usage: Usage = {
				channel: "telemetry",
				requestId,
				schema: observed?.schema ?? "unknown",
				counterScope: "request",
				observedRoute: "unknown",
				billingBasis: "unknown",
				correlation: "explicit",
				raw: observed?.raw ?? {},
				// Terminal counters do not prove that every billable attempt was exposed.
				attemptsComplete: false,
				...(observed
					? {
							reportedModel: observed.reportedModel,
							actualModel: observed.actualModel,
							responseId: observed.responseId,
							provider: observed.provider,
							serviceTier: observed.serviceTier,
							region: observed.region,
							stopReason: observed.rawStopReason,
						}
					: {}),
				...(evidence.billingRecordIds.length
					? {
							aliases: evidence.billingRecordIds.map((id) => ({
								namespace: "castai-request-id",
								id,
								source: "telemetry",
							})),
						}
					: {}),
			}
			let incomplete = false
			if (observed?.iterations?.length) {
				if (observed.iterations.length > 16) {
					usage.schema = "unknown"
					usage.raw = {}
					incomplete = true
				} else {
					usage.iterations = observed.iterations.map((iteration, index) => ({
						id: stableID(entityId, "iteration", String(index)),
						schema: ["message", "fallback_message", "advisor_message", "compaction"].includes(iteration.type ?? "")
							? observed.schema
							: "unknown",
						model: iteration.model,
						raw: iteration.raw,
					}))
					const serving = observed.iterations.flatMap((iteration, index) =>
						iteration.type === "fallback_message" ? [index] : [],
					)
					if (serving.length === 1) usage.finalIterationId = usage.iterations[serving[0]].id
				}
			}
			const target = evidence.destinations.length === 1 ? evidence.destinations[0] : undefined
			const ids = target
				? evidence.candidates.flatMap(({ pullRequest: pr }) =>
						pr?.id &&
						pr.repositoryId === target.id &&
						pr.host === target.host &&
						(pr.provider ?? "github") === target.provider
							? [pr.id]
							: [],
					)
				: []
			const allocation = allocationFor(evidence, ids)
			const destination = ids.length
				? target
				: evidence.correction
					? (previous?.allocation?.targetRepository ?? previous?.repository)
					: undefined
			group.facts.set(entityId, {
				...common,
				entityId,
				usage,
				startedAt: row.startedAt,
				allocation: {
					...allocation,
					...(destination &&
					(!repository ||
						destination.provider !== repository.provider ||
						destination.host !== repository.host ||
						destination.id !== repository.id)
						? { targetRepository: destination }
						: {}),
				},
				...(evidence.correction ? { correction: evidence.correction } : {}),
			})
			const workEntity = stableID("kimchi", "work", key, producerId, row.workId)
			const previousWork = group.facts.get(workEntity)?.work
			const workKeys = new Set([...(previousWork?.issueKeys ?? []).map(({ key }) => key), ...evidence.workIssueKeys])
			group.facts.set(workEntity, {
				...common,
				repository: undefined,
				sourceVersion: "unknown",
				entityId: workEntity,
				work: {
					reason: "observed_request",
					quality: "observed",
					issueKeys: [...workKeys]
						.sort()
						.slice(0, 20)
						.map((key) => ({ key, source: "work" })),
				},
			})
			for (const candidate of evidence.candidates) {
				check()
				const pr = candidate.pullRequest
				if (!pr?.id || !pr.repositoryId || !validTime(pr.checkedAt)) continue
				const repo = { provider: pr.provider ?? "github", host: pr.host, id: pr.repositoryId, name: pr.repository }
				const prEntity = stableID("kimchi", "pull_request", key, producerId, repositoryKey(repo), pr.id)
				const previous = group.facts.get(prEntity)?.pullRequest
				const keys = new Map<string, IssueKey>()
				for (const issue of [
					...(previous?.issueKeys ?? []),
					...evidence.workIssueKeys.map((key) => ({ key, source: "work" })),
					...(pr.branchIssueKeys ?? []).map((key) => ({ key, source: "branch" })),
				])
					keys.set(`${issue.source}:${issue.key}`, issue)
				group.facts.set(prEntity, {
					...common,
					sourceVersion: "unknown",
					entityId: prEntity,
					repository: repo,
					observeTime: pr.checkedAt,
					pullRequest: {
						id: pr.id,
						number: pr.number,
						uri: pr.url,
						state: pr.state,
						title: pullRequestTitle(pr.title),
						author: pullRequestAuthor(pr.author),
						mergeTime: pr.mergedAt ?? undefined,
						closeTime: pr.closedAt ?? undefined,
						mergeCommitId: pr.mergeCommitSha ?? undefined,
						issueKeys: [...keys.values()]
							.sort((a, b) => Number(b.source === "work") - Number(a.source === "work") || a.key.localeCompare(b.key))
							.slice(0, 20),
					},
				})
				const link = stableID("kimchi", "work_pr", key, producerId, row.workId, repositoryKey(repo), pr.id)
				group.facts.set(link, {
					...common,
					sourceVersion: "unknown",
					entityId: link,
					repository: repo,
					observeTime: pr.checkedAt,
					link: {
						fromKind: "work",
						fromId: row.workId,
						toKind: "pull_request",
						toId: pr.id,
						quality:
							allocation.kind === "unknown"
								? "ambiguous"
								: evidence.method === "model" || evidence.method === "session"
									? "inferred"
									: "confirmed",
						reason: evidence.method,
					},
				})
			}
			const problem = nativeProblems.get(requestId)
			if (problem || incomplete || observed?.iterationsIncomplete) {
				unresolved.push({ requestId, recordHashes, reason: problem?.reason ?? "incomplete_native_iterations" })
			} else {
				for (const hash of recordHashes) group.recordHashes.add(hash)
			}
		} catch (error) {
			check()
			unresolved.push({
				requestId,
				recordHashes,
				reason: error instanceof Error ? error.message : "invalid_request_evidence",
			})
		}
	}
	check()
	return {
		accounts: [...accounts.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, group]) => ({
				account: group.account,
				facts: [...group.facts.values()],
				recordHashes: [...group.recordHashes],
			})),
		unresolved,
	}
}
