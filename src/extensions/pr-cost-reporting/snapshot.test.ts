import { describe, expect, it } from "vitest"
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
const pull = (number = 1, repository = "example/repo", repositoryId = "42") => ({
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
