import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"
import { calculatePullRequestCosts } from "../work-attribution/costs.js"
import type { WorkRecord } from "../work-attribution/summary.js"
import {
	accountKey,
	buildSnapshots,
	fitSnapshot,
	repositoryKey,
	SNAPSHOT_LIMITS,
	type SnapshotContent,
	validateSnapshot,
	type WireSnapshot,
	wireBytes,
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
	it("uploads a long-lived work's recent requests without its older unlinked history", () => {
		const rows = records([], { startedAt: "2026-01-01T00:00:00Z" })
		rows.push({ ...rows[0], requestId: billingId, startedAt: at })
		const report = calculatePullRequestCosts(rows, [])
		const result = buildSnapshots(
			rows,
			report,
			new Map([["/private/repo/.git", { provider: "github", host: "github.com", id: "42" }]]),
			true,
		)
		expect(result.snapshots[0].content.requests.map((request) => request.requestId)).toEqual([billingId])
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
	it("exports cross-repository shared work as unknown with each repository's candidate", () => {
		const result = build(records([pull(), pull(2, "example/other", "43")]))
		expect(
			result.snapshots.map(({ content }) => [content.repository.id, content.requests[0].allocation.pullRequestIds]),
		).toEqual([
			["42", ["101"]],
			["43", ["102"]],
		])
		for (const { content } of result.snapshots) {
			expect(content.requests[0].allocation.kind).toBe("unknown")
			expect(() =>
				validateSnapshot({ schemaVersion: 1, producerId: requestId, revision: "1", generatedAt: at, ...content }),
			).not.toThrow()
		}
	})
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
		const content = buildSnapshots(rows, report, repositories, true).snapshots[0].content
		// The server leaves only an unknown request's candidate PRs incomplete.
		expect(content.requests.find((row) => row.requestId === unresolved)?.allocation).toMatchObject({
			kind: "unknown",
			pullRequestIds: [],
		})
		expect(report.pullRequests[0].totalCostUsd).toBe("1.250000000")
	})
	it("ignores unscoped history older than the upload window", () => {
		const legacy: WorkRecord = {
			version: 1,
			type: "request",
			workId: "legacy-work",
			sessionId: "legacy-session",
			requestId: "55555555-5555-4555-8555-555555555555",
			recordedAt: "2026-03-01T00:00:00Z",
		}
		const result = build([legacy, ...records()])
		expect(result).toMatchObject({ skippedRequests: 0, incomplete: false })
		expect(result.snapshots[0].content.coverage.historyComplete).toBe(true)
	})
	it("reports a verified no-charge attempt as priced", () => {
		const unbilled = "55555555-5555-4555-8555-555555555555"
		const rows = [...records(), { ...records()[0], requestId: unbilled }]
		const report = calculatePullRequestCosts(
			rows,
			[{ requestId, billingRecordId: billingId, costUsd: "1.5", account }],
			new Set(),
			new Map([[unbilled, account]]),
		)
		const content = buildSnapshots(rows, report, new Map(), true).snapshots[0].content
		expect(report.pullRequests[0].totalCostUsd).toBe("1.500000000")
		expect(content.coverage).toMatchObject({ observedRequests: 2, unpricedRequests: 0 })
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
			method: "session",
		})
		expect(content.requests[0].billingRecordIds).toEqual([billingId])
		expect(() =>
			validateSnapshot({ schemaVersion: 1, producerId: requestId, revision: "1", generatedAt: at, ...content }),
		).not.toThrow()
	})
	it.each(["open", "merged"] as const)("uploads a model-matched request on a %s PR as a model guess", (state) => {
		const pr = { ...pull(), state, mergedAt: state === "merged" ? pull().mergedAt : null }
		const rows = records([pr], { segment: { id: "segment", attribution: "inferred", reason: "model-same" } })
		const report = calculatePullRequestCosts(rows, [{ requestId, billingRecordId: billingId, costUsd: "1", account }])
		expect(buildSnapshots(rows, report, new Map(), true).snapshots[0].content.requests[0].allocation).toMatchObject({
			method: "model",
		})
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
	it("matches the server's per-snapshot limits", () => {
		expect(SNAPSHOT_LIMITS).toEqual({ requests: 32_000, pullRequests: 250, bytes: 8 * 1024 * 1024 })
	})
	it.each([
		"requests",
		"pullRequests",
		"bills",
		"bytes",
	])("rejects a payload past the %s limit at the boundary", (field) => {
		const value = wire()
		const bills = Array.from(
			{ length: 8 },
			(_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
		)
		if (field === "requests") {
			value.requests = Array.from({ length: 32_001 }, () => value.requests[0])
			value.coverage.observedRequests = 32_001
		}
		if (field === "pullRequests") value.pullRequests = Array.from({ length: 251 }, () => value.pullRequests[0])
		if (field === "bills") value.requests[0].billingRecordIds = [...bills, "00000000-0000-4000-8000-000000000009"]
		if (field === "bytes") {
			// Within every count limit, but 30,000 requests with eight bills each exceed 8 MiB.
			value.requests = Array.from({ length: 30_000 }, (_, index) => ({
				requestId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
				billingRecordIds: bills,
				startedAt: at,
				allocation: { kind: "unlinked", pullRequestIds: [], method: "session" },
			}))
			value.coverage = { observedRequests: 30_000, unpricedRequests: 0, historyComplete: true }
			expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(SNAPSHOT_LIMITS.bytes)
		}
		expect(() => validateSnapshot(value)).toThrow()
	})
	it.each([
		[0, true, true],
		[3, false, true],
		[3, true, false],
		[-1, false, false],
		[1.5, false, false],
	])("accepts %s trimmed requests with complete history=%s: %s", (trimmed, historyComplete, valid) => {
		const value = wire()
		value.coverage = { ...value.coverage, historyComplete, trimmedRequests: trimmed }
		if (valid) expect(() => validateSnapshot(value)).not.toThrow()
		else expect(() => validateSnapshot(value)).toThrow()
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
	it.each([
		["an explicit segment", { id: billingId, attribution: "explicit", reason: "work-command" }, false, "session"],
		["a /work link", { id: billingId, attribution: "session", reason: "test" }, true, "session"],
		[
			"a model match with a /work link",
			{ id: billingId, attribution: "inferred", reason: "model-same" },
			true,
			"model",
		],
	])("never reports a likely PR assignment carrying %s as sure", (_case, segment, linked, method) => {
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
		// Narrowing a request to one PR can leave it likely despite such evidence; it must not reach the server as sure.
		report.requests[0].allocation = "inferred"
		const [request] = buildSnapshots(rows, report, new Map(), true).snapshots[0].content.requests
		expect(request.allocation).toEqual({ kind: "pull-request", pullRequestIds: ["101"], method })
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

describe("per-request upload window and evidence labels", () => {
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
	const correction = (recordedAt: string): WorkRecord => ({
		version: 1,
		type: "work_link",
		workId: work,
		sessionId: "session",
		recordedAt,
		linkId: "77777777-7777-4777-8777-777777777771",
		revision: 1,
		status: "active",
		sourceWorkId: work,
		targetWorkId: work,
		requestIds: [planned],
		scope,
		evidence: { source: "work-command", segmentId: segment },
	})
	const bill = (requestId: string, n: number, billed = account) => ({
		requestId,
		billingRecordId: `44444444-4444-4444-8444-44444444444${n}`,
		costUsd: "1",
		account: billed,
	})
	const snapshot = (rows: WorkRecord[], bills: ReturnType<typeof bill>[]) =>
		buildSnapshots(rows, calculatePullRequestCosts(rows, bills), new Map(), true)

	it("sends a long-lived work's recent requests without its finished history", () => {
		const rows = [
			request(planned, "2026-08-01T00:00:00.000Z"),
			commit([merged("101", "2026-08-02T00:00:00.000Z")]),
			request(later, "2026-10-06T00:00:00.000Z"),
		]
		const { content } = snapshot(rows, [bill(planned, 1), bill(later, 2)]).snapshots[0]
		expect(content.requests.map((row) => row.requestId)).toEqual([later])
	})
	it.each([
		["past day 90", "2026-07-08T12:00:00.000Z"],
		["within the server's last five minutes", "2026-07-09T12:03:00.000Z"],
	])("never sends a correction receipt %s", (_case, mergedAt) => {
		const rows = [
			request(planned, "2026-07-08T11:00:00.000Z"),
			commit([merged("101", mergedAt)]),
			correction("2026-10-01T12:00:00.000Z"),
			request(later, "2026-10-06T12:00:00.000Z"),
		]
		const requests = snapshot(rows, [bill(planned, 1), bill(later, 2)]).snapshots.flatMap(
			(item) => item.content.requests,
		)
		expect(requests.every((row) => row.correction === undefined)).toBe(true)
	})
	it.each([
		["a model match whose bill has not arrived yet", false, "2026-10-06T10:00:00.000Z", "inferred", "model"],
		["a model match that started after the merge", true, "2026-10-06T14:00:00.000Z", "inferred", "model"],
		["an unresolved input", true, "2026-10-06T10:00:00.000Z", "unknown", "session"],
	])("labels %s without claiming recorded evidence", (_case, priced, startedAt, attribution, method) => {
		const rows = [request(planned, startedAt, attribution), commit([merged("101", "2026-10-06T12:00:00.000Z")])]
		const { content } = snapshot(rows, priced ? [bill(planned, 1)] : []).snapshots[0]
		expect(content.requests[0].allocation).toMatchObject({ pullRequestIds: ["101"], method })
	})
	it("keeps repository history complete beside a question asked outside Git", () => {
		const rows = [
			request(planned, "2026-10-06T10:00:00.000Z"),
			commit([merged("101", "2026-10-06T12:00:00.000Z")]),
			{
				version: 1,
				type: "request",
				workId: "55555555-5555-4555-8555-555555555559",
				sessionId: "home-directory",
				requestId: later,
				startedAt: "2026-10-07T09:00:00.000Z",
				recordedAt: "2026-10-07T09:00:00.000Z",
				segment: { id: segment, attribution: "session", reason: "matching-disabled" },
			} satisfies WorkRecord,
		]
		const built = snapshot(rows, [bill(planned, 1), bill(later, 2)])
		expect(built).toMatchObject({ incomplete: false, skippedRequests: 0 })
		expect(built.snapshots[0].content.coverage.historyComplete).toBe(true)
	})
	it("never sends another account's billing IDs for a post-merge request", () => {
		const other = { ...account, organizationId: "99999999-9999-4999-8999-999999999999" }
		const rows = [
			request(planned, "2026-10-06T10:00:00.000Z"),
			request(later, "2026-10-06T14:00:00.000Z"),
			commit([merged("101", "2026-10-06T12:00:00.000Z")]),
		]
		const { content } = snapshot(rows, [bill(planned, 1), bill(later, 3, other)]).snapshots[0]
		expect(content.requests.find((row) => row.requestId === later)).toMatchObject({
			allocation: { kind: "post-merge" },
			billingRecordIds: [],
		})
	})
})

describe("trimming a snapshot to the upload limits", () => {
	const id = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`
	const pr = (number: number, mergedAt?: string) => ({
		id: String(200 + number),
		number,
		url: `https://github.com/example/repo/pull/${number}`,
		...(mergedAt ? { state: "merged" as const, mergedAt } : { state: "open" as const }),
	})
	const request = (n: number, startedAt: string, pullRequestIds: string[], correction = false) => ({
		requestId: id(n),
		billingRecordIds: [],
		startedAt,
		...(correction
			? { correction: { id: billingId, revision: 1, recordedAt: at, source: "work-command" as const } }
			: {}),
		allocation: {
			kind: pullRequestIds.length ? ("pull-request" as const) : ("unlinked" as const),
			pullRequestIds,
			method: "native" as const,
		},
	})
	const content = (): SnapshotContent => ({
		repository: { provider: "github", host: "github.com", id: "42" },
		pullRequests: [pr(1), pr(2, "2026-10-01T00:00:00.000Z"), pr(3, "2026-10-03T00:00:00.000Z")],
		requests: [
			request(1, "2026-10-05T10:00:00.000Z", []),
			request(2, "2026-10-05T09:00:00.000Z", []),
			request(3, "2026-09-30T00:00:00.000Z", ["202"]),
			request(4, "2026-10-02T00:00:00.000Z", ["203"]),
			request(5, "2026-09-01T00:00:00.000Z", ["201"]),
			request(6, "2026-08-01T00:00:00.000Z", [], true),
		],
		coverage: { observedRequests: 6, unpricedRequests: 6, historyComplete: true },
	})
	const trim = (
		limits: Partial<typeof SNAPSHOT_LIMITS>,
		unpriced: (row: SnapshotContent["requests"][number]) => boolean = () => true,
	) => fitSnapshot(content(), { ...SNAPSHOT_LIMITS, ...limits }, unpriced)

	it("leaves a snapshot within the limits untouched", () => {
		const original = content()
		expect(fitSnapshot(original, SNAPSHOT_LIMITS, () => true)).toEqual({ content: original, trimmed: 0 })
	})
	it.each([
		[5, [1, 3, 4, 5, 6], ["201", "202", "203"]],
		[4, [3, 4, 5, 6], ["201", "202", "203"]],
		[3, [4, 5, 6], ["201", "203"]],
		[2, [5, 6], ["201"]],
		[1, [6], []],
	])("keeps %s requests: unlinked work first, then the earliest finished PR, open PRs last, corrections never", (requests, ids, pulls) => {
		const result = trim({ requests })
		expect(result?.content.requests.map((row) => row.requestId)).toEqual(ids.map(id))
		expect(result?.content.pullRequests.map((row) => row.id)).toEqual(pulls)
		expect(result?.content.coverage).toEqual({
			observedRequests: ids.length,
			unpricedRequests: ids.length,
			historyComplete: false,
			trimmedRequests: 6 - ids.length,
		})
		expect(result?.trimmed).toBe(6 - ids.length)
		expect(result?.content.windowedPullRequestIds).toBeUndefined()
		if (result)
			expect(() =>
				validateSnapshot({
					schemaVersion: 1,
					producerId: requestId,
					revision: "2",
					generatedAt: at,
					...result.content,
				}),
			).not.toThrow()
	})
	it("holds instead of dropping an explicit correction", () => {
		expect(trim({ requests: 0 })).toBeUndefined()
	})
	it("meets the PR limit by removing whole finished PRs before open ones, without touching unrelated requests", () => {
		const result = trim({ pullRequests: 1 })
		expect(result?.content.pullRequests.map((row) => row.id)).toEqual(["201"])
		expect(result?.content.requests.map((row) => row.requestId)).toEqual([1, 2, 5, 6].map(id))
		expect(result?.trimmed).toBe(2)
	})
	it("keeps a PR retained only for a revocation receipt", () => {
		const value = content()
		value.pullRequests.push(pr(4, "2026-09-02T00:00:00.000Z"))
		const result = fitSnapshot(value, { ...SNAPSHOT_LIMITS, pullRequests: 3 }, () => true)
		expect(result?.content.pullRequests.map((row) => row.id)).toEqual(["201", "203", "204"])
	})
	it("meets the byte limit, counting the longest envelope a later revision can have", () => {
		const bytes = wireBytes(content()) - 1
		const result = trim({ bytes })
		expect(result?.trimmed).toBe(1)
		expect(result?.content.requests.map((row) => row.requestId)).not.toContain(id(2))
		expect(wireBytes(result?.content ?? content())).toBeLessThanOrEqual(bytes)
		expect(trim({ bytes: 100 })).toBeUndefined()
	})
	it("recounts missing prices among the kept requests", () => {
		expect(trim({ requests: 2 }, (row) => row.requestId === id(5))?.content.coverage.unpricedRequests).toBe(1)
	})
	it("applies a smaller limit the server taught while keeping the full inventory for membership checks", () => {
		const later = "55555555-5555-4555-8555-555555555555"
		const rows = records()
		rows.push({
			...rows[0],
			requestId: later,
			startedAt: "2026-10-04T12:30:00.000Z",
			recordedAt: "2026-10-04T12:30:00.000Z",
		})
		const key = `${accountKey(account)}:${repositoryKey({ provider: "github", host: "github.com", id: "42" })}`
		const [snapshot] = buildSnapshots(
			rows,
			calculatePullRequestCosts(rows, []),
			new Map(),
			true,
			new Map(),
			new Map([[key, { ...SNAPSHOT_LIMITS, requests: 1 }]]),
		).snapshots
		expect(snapshot.content.requests.map((row) => row.requestId)).toEqual([later])
		expect(snapshot.content.pullRequests.map((row) => row.id)).toEqual(["101"])
		expect(snapshot.content.coverage).toMatchObject({ observedRequests: 1, historyComplete: false, trimmedRequests: 1 })
		expect(snapshot.observedRequestIds).toEqual([later, requestId].sort())
	})
})
