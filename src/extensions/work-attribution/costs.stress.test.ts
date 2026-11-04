// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { describe, expect, it } from "vitest"
import { createWorkScopeSnapshot } from "../__mocks__/work-scope.js"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"
import { calculatePullRequestCosts } from "./costs.js"
import type { WorkRecord } from "./summary.js"

/**
 * Adversarial stress suite for the time-split and first-linked narrowing introduced by
 * fix/pr-cost-stacked-mrs. Each test encodes a predicted outcome from reading the
 * implementation; a mismatch is either a misread or a bug — both are findings.
 */

const time = (minutes: number) => new Date(Date.UTC(2026, 9, 2, 10, minutes)).toISOString()
const testScope = createWorkScopeSnapshot("/repo/.git").scope
const one = "github:github.com/example/repository#1"
const two = "github:github.com/example/repository#2"

function pullRequest(overrides: Partial<WorkPullRequest> = {}): WorkPullRequest {
	return {
		provider: "github",
		host: "github.com",
		repository: "example/repository",
		number: 1,
		url: "https://github.com/example/repository/pull/1",
		state: "merged",
		headSha: "a".repeat(40),
		mergeCommitSha: "b".repeat(40),
		mergedAt: time(30),
		closedAt: time(30),
		checkedAt: time(40),
		...overrides,
	}
}

function request(
	requestId: string,
	workId = "work-a",
	sessionId = "session-a",
	recordedAt = time(10),
	fields: Record<string, unknown> = {},
): WorkRecord {
	return { version: 1, type: "request", workId, sessionId, requestId, recordedAt, scope: testScope, ...fields }
}

function commit(
	workId = "work-a",
	pullRequests: WorkPullRequest[] = [pullRequest()],
	sessionId = "session-a",
	fields: Record<string, unknown> = {},
): WorkRecord {
	return {
		version: 1,
		type: "commit",
		workId,
		sessionId,
		sha: "a".repeat(40),
		repository: "/repo/.git",
		worktree: "/repo",
		pullRequests,
		recordedAt: time(20),
		...fields,
	}
}

const minuteOf = (value: string) => Number(value.slice(14, 16))
const open = (checkedAt: number) =>
	pullRequest({ state: "open", mergedAt: null, closedAt: null, mergeCommitSha: null, checkedAt: time(checkedAt) })
const pr = (number: number, checkedAt: number) => ({
	...open(checkedAt),
	number,
	url: `https://github.com/example/repository/pull/${number}`,
})
const row = (sha: string, at: number, pullRequests: WorkPullRequest[], fields: Record<string, unknown> = {}) =>
	commit("work-a", pullRequests, "session-a", {
		sha,
		recordedAt: time(at),
		prLookup: {
			status: "linked",
			checkedAt: time(Math.max(at, Math.min(...pullRequests.map((p) => minuteOf(p.checkedAt))))),
		},
		...fields,
	})

const allocationOf = (report: ReturnType<typeof calculatePullRequestCosts>, requestId: string) => {
	const found = report.requests.find((request) => request.requestId === requestId)
	if (!found) throw new Error(`Missing request ${requestId}`)
	return [found.allocation, ...found.pullRequestIds] as const
}

describe("time split under rewrites (stacked MRs rebased)", () => {
	// Work heads for PR1: commit C1 recorded 20, PR1 first listed 26; then commit C2 recorded 30, PR2 listed 36.
	const base = (rewriteSha: string) => [
		request("r05", "work-a", "session-a", time(5)),
		request("r25", "work-a", "session-a", time(25)),
		row("a".repeat(40), 20, [pr(1, 26)]),
		row("b".repeat(40), 30, [pr(2, 36)]),
		// PR1 merges, the stack is rebased: C1 is rewritten into PR2 as C1' at 50.
		row(rewriteSha, 50, [pr(2, 55)], { rewrittenFrom: "a".repeat(40) }),
	]

	it("keeps historical requests on PR1 when the rewrite sha sorts after the original", () => {
		const report = calculatePullRequestCosts(base("f".repeat(40)), [])
		expect(allocationOf(report, "r05")).toEqual(["unmerged", one])
		expect(allocationOf(report, "r25")).toEqual(["unmerged", one])
	})

	it("keeps historical requests on PR1 when the rewrite sha sorts before the original", () => {
		const report = calculatePullRequestCosts(base("0".repeat(40)), [])
		// The rewrite's own timestamp keeps it from clipping the original commit's stretch.
		expect(allocationOf(report, "r05")).toEqual(["unmerged", one])
		expect(allocationOf(report, "r25")).toEqual(["unmerged", one])
	})

	it("attributes both requests to PR1 before the rewrite row exists (control)", () => {
		const report = calculatePullRequestCosts(base("f".repeat(40)).slice(0, 4), [])
		expect(allocationOf(report, "r05")).toEqual(["unmerged", one])
		expect(allocationOf(report, "r25")).toEqual(["unmerged", one])
	})
})

describe("one commit observed from two sessions of a work", () => {
	// Session A saw the commit in PR1 at 26; session B (a resumed session of the same work)
	// later saw it listed in PR1 and PR2 together at 45.
	const records = [
		request("r05", "work-a", "session-a", time(5)),
		request("r25", "work-a", "session-a", time(25)),
		row("a".repeat(40), 20, [pr(1, 26)]),
		commit("work-a", [pr(1, 45), pr(2, 45)], "session-b", {
			sha: "a".repeat(40),
			recordedAt: time(40),
			prLookup: { status: "linked", checkedAt: time(45) },
		}),
	]

	it("shares the physical commit's narrowed PR set across sessions of a work", () => {
		const report = calculatePullRequestCosts(records, [])
		// The working tree keys PR listings on the physical commit (repository + sha), so session B's
		// observation narrows session A's view too: PR2 was listed later and is dropped for the commit,
		// matching the single-session outcome below.
		expect(allocationOf(report, "r05")).toEqual(["unmerged", one])
		expect(allocationOf(report, "r25")).toEqual(["unmerged", one])
	})

	it("narrows every request to PR1 when the same evidence arrives in one session (control)", () => {
		const single = [
			request("r05", "work-a", "session-a", time(5)),
			request("r25", "work-a", "session-a", time(25)),
			row("a".repeat(40), 20, [pr(1, 26)]),
			commit("work-a", [pr(1, 45), pr(2, 45)], "session-a", {
				sha: "a".repeat(40),
				recordedAt: time(40),
				prLookup: { status: "linked", checkedAt: time(45) },
			}),
		]
		const report = calculatePullRequestCosts(single, [])
		expect(allocationOf(report, "r05")).toEqual(["unmerged", one])
		expect(allocationOf(report, "r25")).toEqual(["unmerged", one])
	})
})

describe("deep stack boundaries", () => {
	const records = [
		...[5, 25, 26, 27, 35, 36, 37, 45, 60].map((minute) =>
			request(`r${String(minute).padStart(2, "0")}`, "work-a", "session-a", time(minute)),
		),
		row("a".repeat(40), 20, [pr(1, 26)]),
		row("b".repeat(40), 30, [pr(2, 36)]),
		row("c".repeat(40), 40, [pr(3, 46)]),
		row("d".repeat(40), 50, [pr(4, 56)]),
	]

	it("maps each request to the stretch it started in, boundaries inclusive, tail to the last PR", () => {
		const report = calculatePullRequestCosts(records, [])
		const three = "github:github.com/example/repository#3"
		const four = "github:github.com/example/repository#4"
		const expected: [string, string][] = [
			["r05", one],
			["r25", one],
			["r26", one],
			["r27", two],
			["r35", two],
			["r36", two],
			["r37", three],
			["r45", three],
			["r60", four],
		]
		for (const [requestId, key] of expected) expect(allocationOf(report, requestId)).toEqual(["unmerged", key])
		expect(calculatePullRequestCosts(records.toReversed(), [])).toEqual(report)
	})
})

describe("degenerate commit timing", () => {
	it("sorts a commit with no valid recordedAt last and still splits around its listing", () => {
		const records = [
			...[5, 25, 30, 60].map((minute) =>
				request(`r${String(minute).padStart(2, "0")}`, "work-a", "session-a", time(minute)),
			),
			row("a".repeat(40), 20, [pr(1, 26)]),
			commit("work-a", [pr(2, 36)], "session-a", {
				sha: "b".repeat(40),
				recordedAt: "not-a-timestamp",
			}),
		]
		const report = calculatePullRequestCosts(records, [])
		expect(allocationOf(report, "r05")).toEqual(["unmerged", one])
		expect(allocationOf(report, "r25")).toEqual(["unmerged", one])
		expect(allocationOf(report, "r30")).toEqual(["unmerged", two])
		expect(allocationOf(report, "r60")).toEqual(["unmerged", two])
	})

	it("extends the last stretch to infinity when no listing time is known for it", () => {
		// PR2's own row carries unusable metadata and no lookup; another commit's row supplies the state.
		const broken = pullRequest({
			number: 2,
			url: "https://github.com/example/repository/pull/2",
			state: "merged",
			mergedAt: null,
			checkedAt: time(45),
		})
		const records = [
			...[5, 25, 28, 42].map((minute) =>
				request(`r${String(minute).padStart(2, "0")}`, "work-a", "session-a", time(minute)),
			),
			row("a".repeat(40), 20, [pr(1, 26)]),
			commit("work-a", [broken], "session-a", { sha: "b".repeat(40), recordedAt: time(30) }),
			row("c".repeat(40), 40, [pr(2, 46)]),
		]
		const report = calculatePullRequestCosts(records, [])
		expect(allocationOf(report, "r05")).toEqual(["unmerged", one])
		expect(allocationOf(report, "r25")).toEqual(["unmerged", one])
		expect(allocationOf(report, "r28")).toEqual(["unmerged", two])
		expect(allocationOf(report, "r42")).toEqual(["unmerged", two])
	})
})

describe("narrowing corner cases", () => {
	it("keeps only the earliest-listed PR when every candidate is closed without merge", () => {
		const records = [
			request("a"),
			commit("work-a", [
				pullRequest({ state: "closed", mergedAt: null, closedAt: time(21), checkedAt: time(21) }),
				pullRequest({
					number: 2,
					url: "https://github.com/example/repository/pull/2",
					state: "closed",
					mergedAt: null,
					closedAt: time(45),
					checkedAt: time(45),
				}),
			]),
		]
		const report = calculatePullRequestCosts(records, [])
		expect(report.requests[0]).toMatchObject({ allocation: "unmerged", pullRequestIds: [one] })
	})

	it("does not time-split across PRs in different repositories", () => {
		const forked = pullRequest({
			repository: "fork/repository",
			number: 2,
			url: "https://github.com/fork/repository/pull/2",
			state: "open",
			mergedAt: null,
			closedAt: null,
			mergeCommitSha: null,
			checkedAt: time(36),
		})
		const records = [
			request("r05", "work-a", "session-a", time(5)),
			row("a".repeat(40), 20, [pr(1, 26)]),
			commit("work-a", [forked], "session-a", {
				sha: "b".repeat(40),
				recordedAt: time(30),
				prLookup: { status: "linked", checkedAt: time(36) },
			}),
		]
		const report = calculatePullRequestCosts(records, [])
		expect(report.requests[0]).toMatchObject({
			allocation: "shared",
			pullRequestIds: [one, "github:github.com/fork/repository#2"],
		})
	})

	it("lets the merged-at filter narrow before the time split, without re-widening", () => {
		// PR1 merged at 25; a request starting after that only leaves PR2.
		const merged = pullRequest({ state: "merged", mergedAt: time(25), closedAt: time(25), checkedAt: time(26) })
		const records = [
			request("r28", "work-a", "session-a", time(28)),
			row("a".repeat(40), 20, [merged]),
			row("b".repeat(40), 30, [pr(2, 36)]),
		]
		const report = calculatePullRequestCosts(records, [])
		expect(report.requests[0]).toMatchObject({ allocation: "unmerged", pullRequestIds: [two] })
	})
})

describe("randomized invariants", () => {
	// Deterministic PRNG so failures reproduce.
	function prng(seed: number) {
		return () => {
			seed |= 0
			seed = (seed + 0x6d2b79f5) | 0
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296
		}
	}

	function scenario(seed: number) {
		const random = prng(seed)
		const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)]
		const shas = ["a", "b", "c", "d", "e", "f"].map((letter) => letter.repeat(40))
		const records: WorkRecord[] = []
		const pulls = [1, 2, 3].map((number) => pr(number, 20 + Math.floor(random() * 60)))
		const commitCount = 1 + Math.floor(random() * 4)
		for (let index = 0; index < commitCount; index++) {
			const sha = pick(shas)
			const at = 5 + Math.floor(random() * 50)
			const linked = pulls.filter(() => random() < 0.45)
			if (!linked.length) linked.push(pick(pulls))
			const fields: Record<string, unknown> = {
				sha,
				recordedAt: random() < 0.1 ? "not-a-timestamp" : time(at),
			}
			if (random() < 0.2) fields.rewrittenFrom = pick(shas)
			const session = random() < 0.25 ? "session-b" : "session-a"
			records.push(
				commit("work-a", linked, session, { ...fields, prLookup: { status: "linked", checkedAt: time(at + 1) } }),
			)
		}
		for (let index = 0; index < 2 + Math.floor(random() * 4); index++) {
			const at = Math.floor(random() * 80)
			const session = random() < 0.25 ? "session-b" : "session-a"
			records.push(request(`r${index}`, "work-a", session, time(at)))
			if (random() < 0.15) records.push(request(`r${index}`, "work-b", session, time(at)))
		}
		return records
	}

	it.each([...Array(120).keys()])("keeps allocation invariants and reversal stability (seed %i)", (seed) => {
		const records = scenario(seed)
		const report = calculatePullRequestCosts(records, [])
		const keys = new Set(report.pullRequests.map((pull) => pull.key))
		for (const request of report.requests) {
			// Every referenced PR exists in the report.
			for (const key of request.pullRequestIds) expect(keys.has(key)).toBe(true)
			// Allocation shape invariants.
			if (request.allocation === "shared") expect(request.pullRequestIds.length).toBeGreaterThan(1)
			if (["pull-request", "inferred", "unmerged"].includes(request.allocation))
				expect(request.pullRequestIds.length).toBe(1)
			if (request.allocation === "unlinked") expect(request.pullRequestIds.length).toBe(0)
		}
		// Reversal stability: row order must not matter.
		expect(calculatePullRequestCosts(records.toReversed(), [])).toEqual(report)
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
