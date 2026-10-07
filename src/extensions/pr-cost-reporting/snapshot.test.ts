import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"
import { calculatePullRequestCosts } from "../work-attribution/costs.js"
import type { WorkRecord } from "../work-attribution/summary.js"
import { buildSnapshots, validateSnapshot, type WireSnapshot } from "./snapshot.js"

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
function build(rows = records(), priced = true) {
	return buildSnapshots(
		rows,
		calculatePullRequestCosts(
			rows,
			priced ? [{ requestId, billingRecordId: billingId, costUsd: "1.234567891", account }] : [],
		),
		new Map(),
		true,
	)
}
function wire(): WireSnapshot {
	return { schemaVersion: 1, producerId: requestId, revision: "1", generatedAt: at, ...build().snapshots[0].content }
}

describe("allowlisted repository snapshots", () => {
	it.each([
		"open",
		"merged",
		"closed",
	] as const)("uploads old work while a PR is %s or within its 32-day grace", (state) => {
		const pr = { ...pull(), state, mergedAt: state === "merged" ? at : null, closedAt: state === "closed" ? at : null }
		const rows = records([pr], { startedAt: "2026-01-01T00:00:00Z", recordedAt: "2026-01-01T00:00:00Z" })
		const content = build(rows).snapshots[0].content
		expect(content.requests).toHaveLength(1)
		expect(content.pullRequests[0]).toMatchObject({ id: pr.id, state })
		if (state === "closed") expect(content.pullRequests[0]).toHaveProperty("closedAt", at)
	})
	it.each([
		"merged",
		"closed",
	] as const)("omits a %s PR after 32 days plus two days of clock grace without treating its evidence as lost", (state) => {
		const finished = "2026-09-03T11:59:59Z"
		const pr = {
			...pull(),
			state,
			mergedAt: state === "merged" ? finished : null,
			closedAt: state === "closed" ? finished : null,
		}
		const rows = records([pr], { startedAt: "2026-08-01T00:00:00Z", recordedAt: "2026-08-01T00:00:00Z" })
		const snapshot = build(rows).snapshots[0]
		expect(snapshot.content.requests).toEqual([])
		expect(snapshot.content.pullRequests).toEqual([])
		expect(snapshot.content).toHaveProperty("windowedPullRequestIds", [pr.id])
		expect(snapshot).toHaveProperty("observedRequestIds", [requestId])
		expect(snapshot.content.coverage).toMatchObject({ observedRequests: 0, unpricedRequests: 0, historyComplete: true })
	})
	it.each([
		"merged",
		"closed",
	] as const)("keeps a %s PR when the client clock is three hours ahead of its 32-day cutoff", (state) => {
		const finished = "2026-09-05T12:00:00Z"
		vi.setSystemTime(new Date("2026-10-07T15:00:00Z"))
		const pr = {
			...pull(),
			state,
			mergedAt: state === "merged" ? finished : null,
			closedAt: state === "closed" ? finished : null,
		}
		const rows = records([pr], { startedAt: "2026-08-01T00:00:00Z", recordedAt: "2026-08-01T00:00:00Z" })
		const content = build(rows).snapshots[0].content
		expect(content.requests.map((request) => request.requestId)).toEqual([requestId])
		expect(content.pullRequests.map((pull) => pull.id)).toEqual([pr.id])
	})
	it("uploads every request in recent work, including its older planning requests", () => {
		const rows = records([], { startedAt: "2026-01-01T00:00:00Z" })
		rows.push({ ...rows[0], requestId: billingId, startedAt: at })
		const report = calculatePullRequestCosts(rows, [])
		const result = buildSnapshots(
			rows,
			report,
			new Map([["/private/repo/.git", { provider: "github", host: "github.com", id: "42" }]]),
			true,
		)
		expect(result.snapshots[0].content.requests).toHaveLength(2)
	})
	it("drops old unlinked work but keeps a closed PR with an unknown close time", () => {
		const rows = records([], { startedAt: "2026-01-01T00:00:00Z" })
		const report = calculatePullRequestCosts(rows, [])
		const result = buildSnapshots(
			rows,
			report,
			new Map([["/private/repo/.git", { provider: "github", host: "github.com", id: "42" }]]),
			true,
		)
		expect(result.snapshots[0].content.requests).toEqual([])
		expect(
			build(records([{ ...pull(), state: "closed", mergedAt: null }], { startedAt: "2026-01-01T00:00:00Z" }))
				.snapshots[0].content.requests,
		).toHaveLength(1)
	})
	it("contains provider and billing evidence only, without prices or private local data", () => {
		const content = build().snapshots[0].content
		expect(content.requests[0]).toEqual({
			requestId,
			billingRecordIds: [billingId],
			startedAt: at,
			allocation: { kind: "pull-request", pullRequestIds: ["101"], method: "native" },
		})
		for (const privateValue of [
			"private-work",
			"private-session",
			"/private",
			"secret text",
			"1.234567891",
			"a".repeat(40),
			account.userId,
		])
			expect(JSON.stringify(content)).not.toContain(privateValue)
		expect(() => validateSnapshot(wire())).not.toThrow()
	})
	it("keeps missing prices in the complete inventory", () => {
		const content = build(records(), false).snapshots[0].content
		expect(content.requests[0].billingRecordIds).toEqual([])
		expect(content.coverage).toMatchObject({ observedRequests: 1, unpricedRequests: 1 })
	})
	it("exports cross-repository shared work as unknown in both repositories", () => {
		const result = build(records([pull(), pull(2, "example/other", "43")]))
		expect(result.snapshots).toHaveLength(2)
		for (const snapshot of result.snapshots)
			expect(snapshot.content.requests[0].allocation).toEqual({ kind: "unknown", pullRequestIds: [], method: "native" })
	})
	it.each([1, 2, 3])("retains all %s post-merge PR candidates in a valid snapshot", (count) => {
		const rows = records(
			Array.from({ length: count }, (_, index) => pull(index + 1)),
			{
				startedAt: "2026-10-04T14:00:00.000Z",
			},
		)
		const report = calculatePullRequestCosts(rows, [{ requestId, billingRecordId: billingId, costUsd: "1", account }])
		expect(report.requests[0].allocation).toBe("post-merge")
		const content = buildSnapshots(rows, report, new Map(), true).snapshots[0].content
		expect(content.requests[0].allocation).toEqual({
			kind: count === 1 ? "post-merge" : "shared",
			pullRequestIds: Array.from({ length: count }, (_, index) => String(101 + index)),
			method: "native",
		})
		expect(content.requests[0].billingRecordIds).toEqual([billingId])
		expect(() =>
			validateSnapshot({ schemaVersion: 1, producerId: requestId, revision: "1", generatedAt: at, ...content }),
		).not.toThrow()
	})
	it("keeps semantic and session assignments visibly inferred", () => {
		for (const [attribution, expected] of [
			["inferred", "model"],
			["session", "session"],
		]) {
			const result = build(
				records([pull()], { segment: { id: "private-segment", attribution, reason: "secret reason" } }),
			)
			expect(result.snapshots[0].content.requests[0].allocation.method).toBe(expected)
		}
	})
	it("does not stamp missing accounts with today's account or export foreign billing IDs", () => {
		expect(build(records([pull()], { scope: undefined })).snapshots).toEqual([])
		const rows = records()
		const report = calculatePullRequestCosts(rows, [
			{ requestId, billingRecordId: billingId, costUsd: "1", account: { ...account, userId: requestId } },
		])
		expect(buildSnapshots(rows, report, new Map(), true).snapshots[0].content.requests[0].billingRecordIds).toEqual([])
	})
	it("keeps billing rows with an unverified contributor out of the upload", () => {
		const rows = records()
		const report = calculatePullRequestCosts(rows, [{ requestId, billingRecordId: billingId, costUsd: "1" }])
		expect(buildSnapshots(rows, report, new Map(), true).snapshots[0].content.requests[0].billingRecordIds).toEqual([])
	})
	it.each(["requests", "pullRequests", "bills", "bytes"])("rejects %s limits without truncating", (field) => {
		const value = wire()
		if (field === "requests") {
			value.requests = Array.from({ length: 10001 }, () => value.requests[0])
			value.coverage.observedRequests = 10001
		}
		if (field === "pullRequests") value.pullRequests = Array.from({ length: 101 }, () => value.pullRequests[0])
		if (field === "bills")
			value.requests[0].billingRecordIds = Array.from(
				{ length: 9 },
				(_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
			)
		if (field === "bytes") Object.assign(value, { privateText: "x".repeat(2 * 1024 * 1024) })
		expect(() => validateSnapshot(value)).toThrow()
	})
	it("rejects unexpected fields in a recovered pending payload", () => {
		const value = wire()
		Object.assign(value.requests[0], { prompt: "must never upload" })
		expect(() => validateSnapshot(value)).toThrow()
	})
	it.each([
		{ id: "not-a-uuid" },
		{ revision: 0 },
		{ revision: 2147483648 },
		{ recordedAt: "yesterday" },
		{ source: "model" },
		{ localPath: "/private/plan.md" },
	])("rejects an invalid or private correction receipt: %j", (fields) => {
		const value = wire()
		value.requests[0].correction = { id: billingId, revision: 1, recordedAt: at, source: "work-command" }
		Object.assign(value.requests[0].correction, fields)
		expect(() => validateSnapshot(value)).toThrow()
	})
	it.each([
		["101"],
		["102", "102"],
		["not-a-provider-id"],
	])("rejects an overlapping or invalid window marker: %j", (...ids) => {
		const value = wire()
		value.windowedPullRequestIds = ids
		expect(() => validateSnapshot(value)).toThrow()
	})
	it("keeps refresh timestamps scoped to requests in the reported account and repository", () => {
		const rows = records()
		const report = calculatePullRequestCosts(rows, [{ requestId, billingRecordId: billingId, costUsd: "1", account }])
		const refreshed = new Map([
			[requestId, at],
			["other-account-request", "2026-10-05T13:00:00Z"],
		])
		expect(
			buildSnapshots(rows, report, new Map(), true, refreshed).snapshots[0].content.coverage.lastCostRefreshAt,
		).toBe(at)
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
		expect(buildSnapshots(rows, report, new Map(), true).snapshots[0].content.requests).toMatchObject([
			{ requestId, allocation: { kind: "pull-request", method: "native" } },
			{ requestId: other, allocation: { kind: "pull-request", method: "session" } },
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
		const result = build(rows)
		expect(result.snapshots[0].content.requests[0]).toHaveProperty("correction", {
			id: "55555555-5555-4555-8555-555555555555",
			revision: 1,
			recordedAt: at,
			source: source === "work-command" ? "work-command" : "producer-confirmation",
		})
		expect(result.snapshots[0].content.requests[0].allocation).toEqual({
			kind: "pull-request",
			pullRequestIds: ["101"],
			method: source === "work-command" ? "user-correction" : "explicit",
		})
	})
	it.each(["active", "revoked"])("uploads an explicit %s correction after the normal window until day 90", (status) => {
		const finished = "2026-08-28T12:00:00.000Z"
		const rows: WorkRecord[] = records([{ ...pull(), mergedAt: finished }], {
			startedAt: "2026-08-27T12:00:00.000Z",
			recordedAt: "2026-08-27T12:00:00.000Z",
			segment: { id: billingId, attribution: "session", reason: "test" },
		}).map((row) => ({ ...row, workId: requestId }))
		rows.push({
			...rows[0],
			type: "work_link",
			recordedAt: at,
			linkId: billingId,
			revision: 2,
			status,
			sourceWorkId: requestId,
			targetWorkId: requestId,
			requestIds: [requestId],
			evidence: { source: "work-command", segmentId: billingId },
		})
		const result = build(rows)
		expect(result.snapshots[0].content.requests).toHaveLength(1)
		expect(result.snapshots[0].content.requests[0]).toHaveProperty("correction", {
			id: billingId,
			revision: 2,
			recordedAt: at,
			source: "work-command",
		})
		expect(result.snapshots[0].content.pullRequests.map((pr) => pr.id)).toEqual(["101"])
		expect(() =>
			validateSnapshot({
				schemaVersion: 1,
				producerId: requestId,
				revision: "2",
				generatedAt: at,
				...result.snapshots[0].content,
			}),
		).not.toThrow()
		vi.setSystemTime(new Date("2026-11-26T12:00:00.000Z"))
		expect(build(rows).snapshots[0].content.requests).toEqual([])
	})
	it.each([
		"active",
		"revoked",
	])("uploads an explicit %s correction from another work after the normal window until day 90", (status) => {
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
		const content = build(rows).snapshots[0].content
		expect(content.requests.find((request) => request.requestId === requestId)).toHaveProperty("correction", {
			id: "99999999-9999-4999-8999-999999999999",
			revision: 2,
			recordedAt: at,
			source: "work-command",
		})
		expect(content.pullRequests.map((pr) => pr.id)).toEqual(["101"])
		expect(content.windowedPullRequestIds).toBeUndefined()
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
		const result = build([...rows, { ...link, status: "active" }, { ...link, status: "revoked" }])
		expect(result.snapshots[0].content.requests[0].allocation.kind).toBe("unknown")
		expect(result.snapshots[0].content.requests[0].correction).toBeUndefined()
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
		const confirmedOnServer = buildSnapshots(rows, report, new Map(), true)
			.snapshots[0].content.requests.filter(
				(request) => request.allocation.kind === "pull-request" && confirmedMethods.includes(request.allocation.method),
			)
			.map((request) => request.requestId)
		expect(confirmedOnServer).toEqual(confirmedLocally)
	})
})

describe("conflicting PR metadata", () => {
	it("holds only the repository whose provider metadata conflicts", () => {
		const other = "55555555-5555-4555-8555-555555555555"
		const healthy = records([pull(2, "example/other", "43")], { requestId: other }).map((row) => ({
			...row,
			workId: "other-work",
		}))
		const rows = [...records(), ...healthy]
		const report = calculatePullRequestCosts(rows, [])
		const bad = report.pullRequests.find((row) => row.pullRequest?.id === "101")
		const request = report.requests.find((row) => row.requestId === requestId)
		if (!bad?.pullRequest || !request) throw new Error("Fixture has no first PR")
		report.pullRequests.push({ ...bad, key: "contradictory", pullRequest: { ...bad.pullRequest, number: 9 } })
		request.pullRequestIds.push("contradictory")
		const result = buildSnapshots(rows, report, new Map(), true)
		expect(result.incomplete).toBe(true)
		expect(result.snapshots.map((snapshot) => snapshot.content.repository.id)).toEqual(["43"])
	})
	it("keeps reporting when a PR has links from before and after a repository rename", () => {
		const beforeRename = { ...pull(1), state: "open", mergedAt: null, checkedAt: "2026-10-04T12:30:00.000Z" }
		const afterRename = { ...pull(1, "example/renamed"), checkedAt: "2026-10-04T13:30:00.000Z" }
		const otherRequest = "55555555-5555-4555-8555-555555555555"
		const [request, commit] = records()
		const rows: WorkRecord[] = [
			request,
			{ ...commit, pullRequests: [beforeRename, afterRename] },
			{
				version: 1,
				type: "request",
				workId: "other-work",
				sessionId: "other-session",
				requestId: otherRequest,
				startedAt: at,
				recordedAt: at,
				scope: { account, repository: "/private/other/.git" },
			},
			{
				version: 1,
				type: "commit",
				workId: "other-work",
				sessionId: "other-session",
				sha: "b".repeat(40),
				repository: "/private/other/.git",
				worktree: "/private/other",
				recordedAt: at,
				pullRequests: [pull(2, "example/other", "43")],
			},
		]
		const report = calculatePullRequestCosts(rows, [])
		let snapshots: ReturnType<typeof buildSnapshots>["snapshots"] = []
		expect(() => {
			snapshots = buildSnapshots(rows, report, new Map(), true).snapshots
		}).not.toThrow()
		expect(snapshots.map((snapshot) => snapshot.content.repository.id).sort()).toEqual(["42", "43"])
	})
})
