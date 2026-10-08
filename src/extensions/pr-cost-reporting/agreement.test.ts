import { readFileSync } from "node:fs"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"
import { calculatePullRequestCosts, decimalNanos, usd } from "../work-attribution/costs.js"
import type { WorkRecord } from "../work-attribution/summary.js"
import { buildSnapshots } from "./snapshot.js"

// The backend checks the same content in services/ai-optimizer/internal/services/prcosts/testdata/client-agreement.golden.
// Update both copies together: they pin where /work and the console must agree.
const account = {
	apiUrl: "https://api.example",
	organizationId: "11111111-1111-4111-8111-111111111111",
	userId: "22222222-2222-4222-8222-222222222222",
}
const started = "2026-10-04T12:00:00.000Z"
const merged = "2026-10-04T13:00:00.000Z"
const repositories = new Map([
	["/repo-a/.git", { provider: "github" as const, host: "github.com", id: "42", name: "example/a" }],
	["/repo-b/.git", { provider: "github" as const, host: "github.com", id: "43", name: "example/b" }],
])
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(new Date("2026-10-07T12:00:00Z"))
})
afterEach(() => vi.useRealTimers())

const id = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-00000000000${n}`
function pull(number: number, repository: "a" | "b"): WorkPullRequest {
	return {
		provider: "github",
		id: String(number),
		repositoryId: repository === "a" ? "42" : "43",
		host: "github.com",
		repository: `example/${repository}`,
		number,
		url: `https://github.com/example/${repository}/pull/${number}`,
		state: "merged",
		mergedAt: merged,
		closedAt: merged,
		checkedAt: merged,
		headSha: "a".repeat(40),
		mergeCommitSha: "b".repeat(40),
	}
}
function work(n: number, pulls: [WorkPullRequest, "a" | "b"][]): WorkRecord[] {
	return pulls.map(([pr, repository], index) => ({
		version: 1,
		type: "commit",
		workId: id("1", n),
		sessionId: "session",
		sha: String(n * 10 + index).padStart(40, "0"),
		repository: `/repo-${repository}/.git`,
		worktree: `/repo-${repository}`,
		recordedAt: merged,
		pullRequests: [pr],
	}))
}
function request(n: number, workNumber: number, attribution: string, startedAt = started): WorkRecord {
	return {
		version: 1,
		type: "request",
		workId: id("1", workNumber),
		sessionId: "session",
		requestId: id("2", n),
		startedAt,
		recordedAt: startedAt,
		scope: { account, repository: "/repo-a/.git" },
		segment: { id: `segment-${n}`, attribution, reason: attribution },
	}
}

it("pins the PR totals that /work and the console must agree on", () => {
	const records = [
		// 101: sure spend, a verified no-charge attempt and later post-merge work.
		...work(1, [[pull(101, "a"), "a"]]),
		request(1, 1, "explicit"),
		request(6, 1, "explicit"),
		request(7, 1, "explicit", "2026-10-04T14:00:00.000Z"),
		// 102: a model match is likely spend.
		...work(2, [[pull(102, "a"), "a"]]),
		request(2, 2, "inferred"),
		// Unresolved matching with no candidate PR leaves every PR complete.
		request(3, 3, "unknown"),
		// 103: an attempt without a verified billing account leaves only its candidate incomplete.
		...work(4, [[pull(103, "a"), "a"]]),
		request(4, 4, "explicit"),
		// 104 and 201: one attempt shared across repositories is counted once and leaves both incomplete.
		...work(5, [
			[pull(104, "a"), "a"],
			[pull(201, "b"), "b"],
		]),
		request(5, 5, "explicit"),
	]
	const bills = [
		{ request: 1, costUsd: "1.25" },
		{ request: 2, costUsd: "2" },
		{ request: 3, costUsd: "3" },
		{ request: 5, costUsd: "5" },
		{ request: 7, costUsd: "7" },
	].map(({ request, costUsd }) => ({
		requestId: id("2", request),
		billingRecordId: id("3", request),
		costUsd,
		account,
	}))
	const noCharge = new Map([[id("2", 6), account]])
	const report = calculatePullRequestCosts(records, bills, new Set(), noCharge)
	const { snapshots, incomplete } = buildSnapshots(records, report, repositories, true)
	expect(incomplete).toBe(false)
	// Each attempt appears once in the request list, whichever bucket or PR it belongs to.
	const organizationNanos = report.requests.reduce((sum, row) => sum + (decimalNanos(row.knownCostUsd) ?? 0n), 0n)
	const fixture = {
		actorId: account.userId,
		snapshots: snapshots.map((snapshot, index) => ({
			schemaVersion: 1,
			producerId: id("4", index + 1),
			revision: "1",
			generatedAt: "2026-10-07T12:00:00.000Z",
			...snapshot.content,
		})),
		bills: bills.map((bill) => ({ id: bill.billingRecordId, ownerId: account.userId, totalPrice: bill.costUsd })),
		noChargeRequestIds: [...noCharge.keys()],
		organizationKnownCostUsd: usd(organizationNanos),
		pullRequests: report.pullRequests
			.map((pr) => ({
				repositoryId: pr.pullRequest?.repositoryId,
				id: pr.pullRequest?.id,
				knownCostUsd: pr.knownCostUsd,
				complete: pr.totalCostUsd !== null,
			}))
			.sort((a, b) => `${a.repositoryId}/${a.id}`.localeCompare(`${b.repositoryId}/${b.id}`)),
	}
	const committed = JSON.parse(readFileSync(new URL("./client-agreement.json", import.meta.url), "utf8"))
	expect(fixture).toEqual(committed)
})
