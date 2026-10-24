import { describe, expect, it } from "vitest"
import {
	COLLECTIONS,
	type Collection,
	commitPullRequests,
	isWorkHead,
	LOGS,
	observeLatest,
	ROW_KEYS,
	type Row,
	summaryLatest,
	type WorkHead,
	type WorkLatest,
} from "./row-log.js"

/**
 * The projection persistence of row-log moved to the SQLite ledger (pr-cost-reporting/ledger/records.ts);
 * what remains here are the pure types and fold helpers shared by capture, import and readers. Kiss-style
 * checks pin that contract; behavior-level persistence coverage lives in ledger/records.test.ts.
 */

describe("collections and keys", () => {
	it("keeps the exact collection set plus sessions as the closing log", () => {
		expect([...COLLECTIONS]).toEqual([
			"workLinks",
			"requests",
			"plans",
			"commits",
			"fileTransitions",
			"fileObservations",
			"continuations",
		])
		expect([...LOGS]).toEqual([...COLLECTIONS, "sessions"])
	})

	it("keys every collection off its stable identity fields", () => {
		expect(ROW_KEYS.requests({ sessionId: "s", requestId: "r" })).toBe(
			ROW_KEYS.requests({ sessionId: "x", requestId: "r" }),
		)
		expect(ROW_KEYS.commits({ sessionId: "s", sha: "a", repository: "repo", worktree: "wt" })).not.toBe(
			ROW_KEYS.commits({ sessionId: "s", sha: "a", repository: "repo", worktree: "wt2" }),
		)
		expect(ROW_KEYS.continuations({ sessionId: "s", source: "a", evidence: {} })).not.toBe(
			ROW_KEYS.continuations({ sessionId: "s", source: "b", evidence: {} }),
		)
	})
})

describe("observeLatest", () => {
	function fold(rows: { collection: Collection; row: Row }[]): WorkLatest {
		const latest: WorkLatest = {}
		for (const { collection, row } of rows) observeLatest(latest, collection, row)
		return latest
	}

	it("tracks the newest request start as activity", () => {
		expect(
			fold([
				{ collection: "requests", row: { sessionId: "s", requestId: "a", startedAt: "2026-10-01T00:00:00Z" } },
				{ collection: "requests", row: { sessionId: "s", requestId: "b", startedAt: "2026-10-02T00:00:00Z" } },
			]),
		).toMatchObject({ activityAt: "2026-10-02T00:00:00Z" })
	})

	it("keeps the older request when the newer timestamp is before it", () => {
		expect(
			fold([
				{ collection: "requests", row: { sessionId: "s", requestId: "a", startedAt: "2026-10-02T00:00:00Z" } },
				{ collection: "requests", row: { sessionId: "s", requestId: "b", startedAt: "2026-10-01T00:00:00Z" } },
			]),
		).toMatchObject({ activityAt: "2026-10-02T00:00:00Z" })
	})

	it("records plan and commit snapshots without dropping repository context", () => {
		const latest = fold([
			{
				collection: "plans",
				row: { sessionId: "s", path: "p", snapshotPath: "s/p", recordedAt: "2026-10-01T00:00:00Z" },
			},
			{
				collection: "commits",
				row: { sessionId: "s", sha: "x", repository: "/r", worktree: "/r", recordedAt: "2026-10-01T00:01:00Z" },
			},
		])
		expect(latest.plan).toEqual({ recordedAt: "2026-10-01T00:00:00Z", snapshotPath: "s/p" })
		expect(latest.commit).toEqual({ recordedAt: "2026-10-01T00:01:00Z", repository: "/r" })
	})
})

describe("commitPullRequests and summaryLatest", () => {
	it("merges links from every commit row, never dropping one from incomplete data", () => {
		const link = (number: number) => ({
			provider: "github",
			host: "github.com",
			id: String(number),
			number,
			url: `https://github.com/o/r/pull/${number}`,
			state: "open",
			checkedAt: "2026-10-01T00:00:00.000Z",
		})
		const links = commitPullRequests([
			{ sessionId: "s", sha: "a", repository: "r", worktree: "r", pullRequests: [link(1)] },
			// Incomplete data: an empty lookup, a row without links, and a link missing its identity must not drop the others.
			{ sessionId: "s", sha: "empty", repository: "r", worktree: "r", pullRequests: [] },
			{ sessionId: "s", sha: "bare", repository: "r", worktree: "r" },
			{
				sessionId: "s",
				sha: "partial",
				repository: "r",
				worktree: "r",
				pullRequests: [{ provider: "github", id: "3", number: 3 }],
			},
			{ sessionId: "s", sha: "b", repository: "r", worktree: "r", pullRequests: [link(2)] },
		])
		expect(links.map((row) => row.number)).toEqual([1, 2])
	})

	it("recomputes latest from a full row iterator", () => {
		const rows = (collection: Collection): Row[] =>
			collection === "requests"
				? [{ sessionId: "s", requestId: "r", startedAt: "2026-10-03T00:00:00Z", cwd: "/w" }]
				: []
		const summary = summaryLatest((collection) => rows(collection))
		expect(summary.latest.activityAt).toBe("2026-10-03T00:00:00Z")
		expect(summary.pullRequests).toEqual([])
	})
})

describe("isWorkHead", () => {
	const head: WorkHead = {
		version: 2,
		workId: "11111111-1111-4111-8111-111111111111",
		updatedAt: "2026-10-01T00:00:00.000Z",
		logs: { requests: { generation: 1, bytes: 40, rows: 1 } },
		latest: {},
		pullRequests: [],
	}
	it("accepts the current manifest shape", () => {
		expect(isWorkHead(head, head.workId)).toBe(true)
	})
	it("rejects foreign work ids, missing logs and wrong versions", () => {
		expect(isWorkHead(head, "22222222-2222-4222-8222-222222222222")).toBe(false)
		expect(isWorkHead({ ...head, logs: undefined }, head.workId)).toBe(false)
		expect(isWorkHead({ ...head, version: 1 }, head.workId)).toBe(false)
	})
})
