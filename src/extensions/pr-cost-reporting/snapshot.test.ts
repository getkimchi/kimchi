import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"
import { calculatePullRequestCosts, type PullRequestCostReport } from "../work-attribution/costs.js"
import type { WorkRecord } from "../work-attribution/summary.js"
import {
	allocationFor,
	type ReportingRepository,
	type RepositoryIdentity,
	type RequestAttribution,
	requestAttributions,
} from "./snapshot.js"

const account = {
	apiUrl: "https://api.example",
	organizationId: "11111111-1111-4111-8111-111111111111",
	userId: "22222222-2222-4222-8222-222222222222",
}
const requestId = "33333333-3333-4333-8333-333333333333"
const billingId = "44444444-4444-4444-8444-444444444444"
const at = "2026-10-04T12:00:00.000Z"
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(new Date("2026-10-07T12:00:00Z"))
})
afterEach(() => vi.useRealTimers())
const pull = (number = 1, repository = "example/repo", repositoryId = "42"): WorkPullRequest => ({
	provider: "github",
	id: String(100 + number),
	repositoryId,
	host: "github.com",
	repository,
	number,
	url: `https://github.com/${repository}/pull/${number}`,
	state: "merged",
	mergedAt: "2026-10-04T13:00:00.000Z",
	closedAt: null,
	checkedAt: at,
	headSha: "a".repeat(40),
	mergeCommitSha: null,
})
function records(pulls = [pull()], fields: Record<string, unknown> = {}): WorkRecord[] {
	return [
		{
			version: 1,
			type: "request",
			workId: "private-work",
			sessionId: "private-session",
			requestId,
			startedAt: at,
			recordedAt: at,
			scope: { account, repository: "/private/repo/.git" },
			prompt: "secret text",
			...fields,
		},
		{
			version: 1,
			type: "commit",
			workId: "private-work",
			sessionId: "private-session",
			sha: "a".repeat(40),
			repository: "/private/repo/.git",
			worktree: "/private/repo",
			recordedAt: at,
			pullRequests: pulls,
		},
	]
}
/** The report with the request's bill, as local cost summaries see it. */
const priced = (rows: WorkRecord[]) =>
	calculatePullRequestCosts(rows, [{ requestId, billingRecordId: billingId, costUsd: "1.234567891", account }])
function attributed(
	rows: WorkRecord[],
	report: PullRequestCostReport = calculatePullRequestCosts(rows, []),
	id = requestId,
	repositories = new Map<string, RepositoryIdentity>(),
): RequestAttribution {
	const attribution = requestAttributions(rows, report, repositories).get(id)
	if (!attribution) throw new Error("Missing original request")
	return attribution
}
/** The allocation an event carries when all candidate PRs are in its one destination repository. */
const allocated = (attribution: RequestAttribution) =>
	allocationFor(
		attribution,
		attribution.candidates.flatMap(({ pullRequest }) => (pullRequest?.id ? [pullRequest.id] : [])),
	)

describe("unwindowed request attribution", () => {
	const repo: ReportingRepository = { provider: "github", host: "github.com", id: "42", name: "example/repo" }
	it("retains old unlinked inventory", () => {
		const rows = records([], { startedAt: "2026-01-01T00:00:00Z", recordedAt: "2026-01-01T00:00:00Z" })
		const report = calculatePullRequestCosts(rows, [])
		const repositories = new Map([["/private/repo/.git", repo]])
		const attribution = requestAttributions(rows, report, repositories).get(requestId)
		if (!attribution) throw new Error("Missing original request")
		expect(attribution.destinations).toEqual([repo])
		expect(allocationFor(attribution, [])).toEqual({ kind: "unlinked", pullRequestIds: [], method: "session" })
	})
	it("retains candidates of long-settled PRs", () => {
		const pr = { ...pull(), mergedAt: "2026-07-01T00:00:00Z" }
		const rows = records([pr], { startedAt: "2026-06-30T00:00:00Z", recordedAt: "2026-06-30T00:00:00Z" })
		const report = calculatePullRequestCosts(rows, [])
		const attribution = requestAttributions(rows, report, new Map()).get(requestId)
		if (!attribution) throw new Error("Missing original request")
		expect(attribution.candidates.map((candidate) => candidate.pullRequest?.id)).toEqual([pr.id])
		expect(allocationFor(attribution, ["101"]).kind).toBe("pull-request")
	})
	it("keeps all candidate repositories unknown instead of choosing one", () => {
		const rows = records([pull(), pull(2, "example/other", "43")])
		const attribution = requestAttributions(rows, calculatePullRequestCosts(rows, []), new Map()).get(requestId)
		if (!attribution) throw new Error("Missing original request")
		expect(attribution.destinations.map((destination) => destination.id)).toEqual(["42", "43"])
		expect(attribution.candidates).toHaveLength(2)
		expect(allocationFor(attribution, ["101"]).kind).toBe("unknown")
		expect(allocationFor(attribution, ["101", "102"]).kind).toBe("unknown")
	})
	it.each(["active", "revoked"])("keeps the validated %s receipt of a long-settled PR", (status) => {
		const rows: WorkRecord[] = records([{ ...pull(), mergedAt: "2026-07-01T00:00:00Z" }], {
			segment: { id: billingId, attribution: "session", reason: "test" },
		}).map((row) => ({ ...row, workId: requestId }))
		rows.push({
			...rows[0],
			type: "work_link",
			linkId: billingId,
			revision: 2,
			status,
			sourceWorkId: requestId,
			targetWorkId: requestId,
			requestIds: [requestId],
			evidence: { source: "work-command", segmentId: billingId },
		})
		const report = calculatePullRequestCosts(rows, [])
		expect(requestAttributions(rows, report, new Map()).get(requestId)?.correction).toEqual({
			id: billingId,
			revision: 2,
			recordedAt: at,
			source: "work-command",
		})
	})
	it.each(["session", "inferred"])("preserves an inferred %s method", (attribution) => {
		const rows = records([pull()], { segment: { id: billingId, attribution, reason: "test" } })
		const report = calculatePullRequestCosts(rows, [])
		report.requests[0].allocation = "inferred"
		const projected = requestAttributions(rows, report, new Map()).get(requestId)
		if (!projected) throw new Error("Missing original request")
		expect(allocationFor(projected, ["101"])).toEqual({
			kind: "pull-request",
			pullRequestIds: ["101"],
			method: attribution === "inferred" ? "model" : "session",
		})
	})
	it("retains genuine owned bill IDs for historical requests without native counters", () => {
		const rows = records()
		const report = calculatePullRequestCosts(rows, [{ requestId, billingRecordId: billingId, costUsd: "1", account }])
		const attribution = requestAttributions(rows, report, new Map()).get(requestId)
		expect(attribution).toMatchObject({ billingAccountVerified: true, billingRecordIds: [billingId] })
	})
	it("does not export bills from a different reporting account", () => {
		const rows = records()
		const report = calculatePullRequestCosts(rows, [
			{
				requestId,
				billingRecordId: billingId,
				costUsd: "1",
				account: { ...account, userId: "66666666-6666-4666-8666-666666666666" },
			},
		])
		expect(requestAttributions(rows, report, new Map()).get(requestId)).toMatchObject({
			billingAccountVerified: false,
			billingRecordIds: [],
		})
	})
	it("leaves missing original account and unresolved repository identities missing", () => {
		const rows = records([], { scope: undefined })
		const repositories = new Map([["/private/repo/.git", repo]])
		expect(requestAttributions(rows, calculatePullRequestCosts(rows, []), repositories).get(requestId)).toMatchObject({
			request: { account: null },
			destinations: [],
			missing: true,
		})
		const scoped = records([])
		expect(requestAttributions(scoped, calculatePullRequestCosts(scoped, []), new Map()).get(requestId)).toMatchObject({
			destinations: [],
			missing: true,
		})
	})
	it("keeps a request in a repository without a provider identity complete and unlinked", () => {
		const rows = records([])
		const attribution = attributed(rows, undefined, requestId, new Map([["/private/repo/.git", "unsupported"]]))
		expect(attribution).toMatchObject({ destinations: [], missing: false })
		expect(allocationFor(attribution, [])).toMatchObject({ kind: "unlinked" })
	})
	it("keeps request-captured Jira keys instead of current work metadata", () => {
		const rows = records([pull()], { issue: { key: "ORIGINAL-1" } })
		rows.push({
			version: 1,
			type: "work",
			workId: "private-work",
			sessionId: "private-session",
			issue: { key: "CURRENT-2" },
		})
		expect(
			requestAttributions(rows, calculatePullRequestCosts(rows, []), new Map()).get(requestId)?.workIssueKeys,
		).toEqual(["ORIGINAL-1"])
	})
})

describe("request allocation and billing evidence", () => {
	it("keeps a PR complete beside an unknown request that cannot belong to it", () => {
		const unresolved = "55555555-5555-4555-8555-555555555555"
		const other: WorkRecord = {
			...records()[0],
			workId: "other-work",
			sessionId: "other-session",
			requestId: unresolved,
			segment: { id: "segment", attribution: "unknown", reason: "model-uncertain" },
		}
		const rows = [...records(), other]
		const report = calculatePullRequestCosts(
			rows,
			[{ requestId, billingRecordId: billingId, costUsd: "1.25", account }],
			new Set(),
			new Map([[unresolved, account]]),
		)
		const repositories = new Map([
			["/private/repo/.git", { provider: "github" as const, host: "github.com", id: "42" }],
		])
		// The server leaves only an unknown request's candidate PRs incomplete.
		expect(allocated(attributed(rows, report, unresolved, repositories))).toMatchObject({
			kind: "unknown",
			pullRequestIds: [],
		})
		expect(report.pullRequests[0].totalCostUsd).toBe("1.250000000")
	})
	it.each([1, 2, 3])("retains all %s post-merge PR candidates in one claim", (count) => {
		const rows = records(
			Array.from({ length: count }, (_, index) => pull(index + 1)),
			{
				startedAt: "2026-10-04T14:00:00.000Z",
			},
		)
		const report = calculatePullRequestCosts(rows, [{ requestId, billingRecordId: billingId, costUsd: "1", account }])
		expect(report.requests[0].allocation).toBe("post-merge")
		const attribution = attributed(rows, report)
		expect(allocated(attribution)).toEqual({
			kind: count === 1 ? "post-merge" : "shared",
			pullRequestIds: Array.from({ length: count }, (_, index) => String(101 + index)),
			method: "session",
		})
		expect(attribution.billingRecordIds).toEqual([billingId])
	})
	it.each(["open", "merged"] as const)("labels a model-matched request on a %s PR as a model guess", (state) => {
		const pr = { ...pull(), state, mergedAt: state === "merged" ? pull().mergedAt : null }
		const rows = records([pr], { segment: { id: "segment", attribution: "inferred", reason: "model-same" } })
		const report = calculatePullRequestCosts(rows, [{ requestId, billingRecordId: billingId, costUsd: "1", account }])
		expect(attributed(rows, report).method).toBe("model")
	})
	it("keeps billing rows with an unverified contributor out of the upload", () => {
		const rows = records()
		const report = calculatePullRequestCosts(rows, [{ requestId, billingRecordId: billingId, costUsd: "1" }])
		expect(attributed(rows, report).billingRecordIds).toEqual([])
	})
	it("sends a request with more than 8 bills without IDs, so the server finds them by its tag", () => {
		const rows = records()
		const bills = Array.from({ length: 9 }, (_, index) => ({
			requestId,
			billingRecordId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
			costUsd: "0.100000000",
			account,
		}))
		const attribution = attributed(rows, calculatePullRequestCosts(rows, bills))
		expect(attribution.request.billingRecordIds).toHaveLength(9)
		expect(attribution.billingRecordIds).toEqual([])
	})
})

describe("local and reported confidence", () => {
	it("sends native evidence for the editing input and session evidence for a separate input", () => {
		const segment = { id: billingId, attribution: "session", reason: "matching-disabled" }
		const [request, commit] = records([pull()], { segment })
		const other = "55555555-5555-4555-8555-555555555555"
		const transition: WorkRecord = {
			...request,
			type: "file_transition",
			transitionId: "edit",
			toolCallId: "tool",
			cwd: "/private/repo",
			repository: "/private/repo/.git",
			worktree: "/private/repo",
			path: "code.ts",
			baseline: "c".repeat(40),
			baselineFile: { blob: "d".repeat(40), mode: "100644" },
			before: { blob: "d".repeat(40), mode: "100644" },
			after: { blob: "e".repeat(40), mode: "100644" },
			cursor: { bytes: 100, digest: "f".repeat(64) },
		}
		const rows = [
			request,
			{ ...request, requestId: other, segment: { ...segment, id: other } },
			transition,
			{
				...commit,
				source: "native-file-transition",
				paths: ["code.ts"],
				transitionIds: ["edit"],
				fileMatches: [{ path: "code.ts", worktree: "/private/repo", method: "file-chain", transitionIds: ["edit"] }],
			},
		]
		const report = calculatePullRequestCosts(rows, [
			{ requestId, billingRecordId: billingId, costUsd: "0.1", account },
			{ requestId: other, billingRecordId: other, costUsd: "0.000000001", account },
		])
		expect(report.pullRequests[0]).toMatchObject({
			totalCostUsd: "0.100000001",
			explicit: { requestIds: [requestId] },
			inferred: { requestIds: [other] },
		})
		expect([requestId, other].map((id) => allocated(attributed(rows, report, id)))).toMatchObject([
			{ kind: "pull-request", method: "native" },
			{ kind: "pull-request", method: "session" },
		])
	})
	it.each([
		"saved-plan",
		"pasted-plan",
		"named-artifact",
		"work-command",
	])("labels a %s confirmation with its actual source", (source) => {
		const rows: WorkRecord[] = records([pull()], {
			segment: { id: billingId, attribution: "session", reason: "test" },
		}).map((row) => ({ ...row, workId: requestId }))
		rows.push({
			...rows[0],
			type: "work_link",
			linkId: "55555555-5555-4555-8555-555555555555",
			revision: 1,
			status: "active",
			sourceWorkId: requestId,
			targetWorkId: requestId,
			requestIds: [requestId],
			evidence: { source, requestId, segmentId: billingId },
		})
		const attribution = attributed(rows, priced(rows))
		expect(attribution.correction).toEqual({
			id: "55555555-5555-4555-8555-555555555555",
			revision: 1,
			recordedAt: at,
			source: source === "work-command" ? "work-command" : "producer-confirmation",
		})
		expect(allocated(attribution)).toEqual({
			kind: "pull-request",
			pullRequestIds: ["101"],
			method: source === "work-command" ? "user-correction" : "explicit",
		})
	})
	it.each(["active", "revoked"])("keeps an explicit %s correction from another work", (status) => {
		const planning = "66666666-6666-4666-8666-666666666666"
		const implementing = "77777777-7777-4777-8777-777777777777"
		const finished = "2026-08-28T12:00:00.000Z"
		const [plan, commit] = records([{ ...pull(), mergedAt: finished }], {
			startedAt: "2026-08-27T12:00:00.000Z",
			recordedAt: "2026-08-27T12:00:00.000Z",
			segment: { id: billingId, attribution: "unknown", reason: "unresolved-reference" },
		})
		const rows: WorkRecord[] = [
			{ ...plan, workId: planning },
			{
				...plan,
				workId: implementing,
				requestId: "88888888-8888-4888-8888-888888888888",
				segment: { id: implementing, attribution: "explicit", reason: "work-command" },
			},
			{ ...commit, workId: implementing },
			{
				...plan,
				type: "work_link",
				workId: implementing,
				recordedAt: at,
				linkId: "99999999-9999-4999-8999-999999999999",
				revision: 2,
				status,
				sourceWorkId: planning,
				targetWorkId: implementing,
				requestIds: [requestId],
				evidence: { source: "work-command", segmentId: billingId },
			},
		]
		expect(attributed(rows, priced(rows)).correction).toEqual({
			id: "99999999-9999-4999-8999-999999999999",
			revision: 2,
			recordedAt: at,
			source: "work-command",
		})
	})
	it("does not send a correction when copies disagree about whether the same revision was revoked", () => {
		const rows = records().map((row) => ({ ...row, workId: requestId }))
		const link: WorkRecord = {
			...rows[0],
			type: "work_link",
			linkId: billingId,
			revision: 2,
			sourceWorkId: requestId,
			targetWorkId: requestId,
			requestIds: [requestId],
			evidence: { source: "work-command" },
		}
		const copies = [...rows, { ...link, status: "active" }, { ...link, status: "revoked" }]
		const attribution = attributed(copies, priced(copies))
		expect(allocated(attribution).kind).toBe("unknown")
		expect(attribution.correction).toBeUndefined()
	})
	it.each([
		["an explicit segment", { id: billingId, attribution: "explicit", reason: "work-command" }, false, "session"],
		["a /work link", { id: billingId, attribution: "session", reason: "test" }, true, "session"],
		[
			"a model match with a /work link",
			{ id: billingId, attribution: "inferred", reason: "model-same" },
			true,
			"model",
		],
	])("never reports an inferred PR assignment carrying %s as confirmed", (_case, segment, linked, method) => {
		const rows: WorkRecord[] = records([pull()], { segment }).map((row) => ({ ...row, workId: requestId }))
		if (linked)
			rows.push({
				...rows[0],
				type: "work_link",
				linkId: "55555555-5555-4555-8555-555555555555",
				revision: 1,
				status: "active",
				sourceWorkId: requestId,
				targetWorkId: requestId,
				requestIds: [requestId],
				evidence: { source: "work-command", requestId, segmentId: billingId },
			})
		const report = calculatePullRequestCosts(rows, [{ requestId, billingRecordId: billingId, costUsd: "1", account }])
		// Narrowing a request to one PR can leave it inferred despite such evidence; it must not reach the server as confirmed.
		report.requests[0].allocation = "inferred"
		const request = attributed(rows, report)
		expect(allocated(request)).toEqual({ kind: "pull-request", pullRequestIds: ["101"], method })
		if (linked) expect(request.correction).toMatchObject({ source: "work-command" })
	})
	// The server counts only native, explicit and user-correction methods as confirmed (explicit) PR spend.
	const confirmedMethods = ["native", "explicit", "user-correction"]
	it.each([
		"session",
		"explicit",
		"inferred",
	] as const)("reports a %s request with the confidence it has in the local PR total", (attribution) => {
		const rows = records([pull()], { segment: { id: "segment", attribution, reason: "test" } })
		const report = calculatePullRequestCosts(rows, [{ requestId, billingRecordId: billingId, costUsd: "1", account }])
		const confirmedLocally = report.requests
			.filter((request) => request.allocation === "pull-request")
			.map((request) => request.requestId)
		const attributions = requestAttributions(rows, report, new Map())
		const confirmedOnServer = report.requests
			.filter((request) => {
				const value = attributions.get(request.requestId)
				const allocation = value && allocated(value)
				return allocation?.kind === "pull-request" && confirmedMethods.includes(allocation.method)
			})
			.map((request) => request.requestId)
		expect(confirmedOnServer).toEqual(confirmedLocally)
	})
})

describe("evidence labels", () => {
	const work = "55555555-5555-4555-8555-555555555551"
	const planned = "33333333-3333-4333-8333-333333333331"
	const later = "33333333-3333-4333-8333-333333333332"
	const segment = "66666666-6666-4666-8666-666666666661"
	const scope = { account, repository: "/private/repo/.git" }
	const merged = (id: string, mergedAt: string | null, number = 1): WorkPullRequest => ({
		...pull(number),
		id,
		state: mergedAt ? "merged" : "open",
		mergedAt,
		checkedAt: mergedAt ?? at,
	})
	const request = (requestId: string, startedAt: string, attribution = "session", reason = "test"): WorkRecord => ({
		version: 1,
		type: "request",
		workId: work,
		sessionId: "session",
		requestId,
		startedAt,
		recordedAt: startedAt,
		scope,
		segment: { id: segment, attribution, reason },
	})
	const commit = (pullRequests: WorkPullRequest[], sha = "b"): WorkRecord => ({
		version: 1,
		type: "commit",
		workId: work,
		sessionId: "session",
		sha: sha.repeat(40),
		repository: "/private/repo/.git",
		worktree: "/private/repo",
		recordedAt: "2026-07-01T00:00:00.000Z",
		pullRequests,
	})
	const bill = (requestId: string, n: number, billed = account) => ({
		requestId,
		billingRecordId: `44444444-4444-4444-8444-44444444444${n}`,
		costUsd: "1",
		account: billed,
	})

	it.each([
		["a model match whose bill has not arrived yet", false, "2026-10-06T10:00:00.000Z", "inferred", "model"],
		["a model match that started after the merge", true, "2026-10-06T14:00:00.000Z", "inferred", "model"],
		["an unresolved input", true, "2026-10-06T10:00:00.000Z", "unknown", "session"],
	])("labels %s without claiming recorded evidence", (_case, billed, startedAt, attribution, method) => {
		const rows = [request(planned, startedAt, attribution), commit([merged("101", "2026-10-06T12:00:00.000Z")])]
		const report = calculatePullRequestCosts(rows, billed ? [bill(planned, 1)] : [])
		expect(allocated(attributed(rows, report, planned))).toMatchObject({ pullRequestIds: ["101"], method })
	})
	it("never sends another account's billing IDs for a post-merge request", () => {
		const other = { ...account, organizationId: "99999999-9999-4999-8999-999999999999" }
		const rows = [
			request(planned, "2026-10-06T10:00:00.000Z"),
			request(later, "2026-10-06T14:00:00.000Z"),
			commit([merged("101", "2026-10-06T12:00:00.000Z")]),
		]
		const attribution = attributed(
			rows,
			calculatePullRequestCosts(rows, [bill(planned, 1), bill(later, 3, other)]),
			later,
		)
		expect(allocated(attribution)).toMatchObject({ kind: "post-merge" })
		expect(attribution.billingRecordIds).toEqual([])
	})
})
