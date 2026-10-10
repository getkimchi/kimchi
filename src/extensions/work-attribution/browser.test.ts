import * as fs from "node:fs"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import * as asyncFs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildWorkBrowser, readWorkBrowser, type SavedWork } from "./browser.js"
import { type WorkCostReport, workCostDetails, workCostTotals } from "./cost-details.js"
import type { PullRequestCost } from "./costs.js"
import { summaryHead, type WorkHead } from "./row-log.js"

vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof asyncFs>()) }))

const NOW = Date.parse("2026-10-08T12:00:00Z")
const HOUR = 60 * 60_000
const DAY = 24 * HOUR
let agentDir: string

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "kimchi-work-browser-"))
	vi.stubEnv("TZ", "UTC")
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(agentDir, { recursive: true, force: true })
})

function workId(index: number): string {
	return `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`
}
function summary(id: string, fields: Record<string, unknown[]> = {}) {
	return {
		version: 1,
		workId: id,
		sessions: ["session"],
		requests: [],
		plans: [],
		commits: [],
		fileTransitions: [],
		...fields,
	}
}
function request(requestId: string, startedAt = "2026-10-08T09:00:00Z") {
	return { requestId, sessionId: "session", startedAt, cwd: "/src/kimchi", scope: { repository: "/src/kimchi/.git" } }
}
function costs(
	id: string,
	requests: { requestId: string; usd?: string; priced?: boolean; workIds?: string[]; linkedWorkIds?: string[] }[],
	pullRequests: PullRequestCost[] = [],
): WorkCostReport {
	return {
		workId: id,
		pullRequests,
		requests: requests.map(({ requestId, usd = "0", priced = true, workIds = [id], linkedWorkIds }) => ({
			requestId,
			account: null,
			workIds,
			...(linkedWorkIds ? { linkedWorkIds } : {}),
			sessionIds: ["session"],
			startedAt: null,
			pullRequestIds: [],
			allocation: "unlinked",
			billingRecordIds: [],
			priceStatus: priced ? "priced" : "missing",
			knownCostUsd: usd,
			totalCostUsd: priced ? usd : null,
		})),
	}
}
/** A saved PR total; request lists and portions not given are empty. */
function pullRequestCost(
	row: Pick<PullRequestCost, "key" | "pullRequest" | "workIds" | "knownCostUsd" | "totalCostUsd"> &
		Partial<PullRequestCost>,
): PullRequestCost {
	const empty = { requestIds: [], knownCostUsd: "0.000000000", totalCostUsd: "0.000000000" }
	return {
		account: null,
		requestIds: [],
		explicit: empty,
		inferred: empty,
		sharedRequestIds: [],
		inferredRequestIds: [],
		unknownRequestIds: [],
		...row,
	}
}
function pullRequest(number: number, state: "open" | "closed" | "merged", provider: "github" | "gitlab" = "github") {
	const finished = state === "open" ? null : "2026-10-07T10:00:00Z"
	const path =
		provider === "github" ? `example/kimchi/pull/${number}` : `example/team/kimchi/-/merge_requests/${number}`
	return {
		provider,
		host: `${provider}.com`,
		repository: provider === "github" ? "example/kimchi" : "example/team/kimchi",
		number,
		url: `https://${provider}.com/${path}`,
		state,
		headSha: "a".repeat(40),
		mergeCommitSha: state === "merged" ? "b".repeat(40) : null,
		mergedAt: state === "merged" ? finished : null,
		closedAt: finished,
		checkedAt: "2026-10-07T11:00:00Z",
	}
}
function commit(sha: string, pullRequests: unknown[]) {
	return {
		sha: sha.repeat(40),
		repository: "/src/kimchi/.git",
		worktree: "/src/kimchi",
		sessionId: "session",
		recordedAt: "2026-10-07T09:00:00Z",
		pullRequests,
	}
}
function save(
	id: string,
	files: { summary?: unknown; costs?: WorkCostReport; totals?: string; plans?: Record<string, string> },
	at = NOW,
) {
	const folder = join(agentDir, "work", id)
	mkdirSync(join(folder, "plans"), { recursive: true })
	const totals = files.totals ?? (files.costs === undefined ? undefined : JSON.stringify(workCostTotals(files.costs)))
	for (const [name, value] of [
		["work.json", files.summary],
		["costs.json", files.costs],
		["cost-totals.json", totals],
	] as const)
		if (value !== undefined)
			writeFileSync(join(folder, name), typeof value === "string" ? value : JSON.stringify(value))
	for (const [name, text] of Object.entries(files.plans ?? {})) writeFileSync(join(folder, "plans", name), text)
	if (files.summary !== undefined) utimesSync(join(folder, "work.json"), new Date(at), new Date(at))
}
function browse(
	works: { workId: string; summary?: ReturnType<typeof summary>; costs?: WorkCostReport }[],
	lines: string[] = [],
) {
	const saved: SavedWork[] = works.map((work) => ({
		workId: work.workId,
		head: work.summary && summaryHead(work.summary, work.workId, new Date(NOW).toISOString()),
		totals: work.costs && workCostTotals(work.costs),
	}))
	return buildWorkBrowser(agentDir, { workId: works[0].workId, lines }, saved)
}

describe("work browser rows", () => {
	it("lists the current work first, then recent works by last activity, and leaves out old works", async () => {
		const [current, older, newer, stale, idle] = [1, 2, 3, 4, 5].map(workId)
		save(current, { summary: summary(current, { requests: [request("r1", "2026-09-20T09:00:00Z")] }) }, NOW - DAY)
		// A later background update does not make older work more recent than newer activity.
		save(older, { summary: summary(older, { requests: [request("r2", "2026-10-07T10:00:00Z")] }) }, NOW - HOUR)
		save(newer, { summary: summary(newer, { requests: [request("r3", "2026-10-08T09:00:00Z")] }) }, NOW - 2 * HOUR)
		save(stale, { summary: summary(stale, { requests: [request("r4", "2026-08-20T09:00:00Z")] }) }, NOW - 40 * DAY)
		// A request's final cost record rewrites the summary of work idle for over a month.
		save(idle, { summary: summary(idle, { requests: [request("r5", "2026-08-19T09:00:00Z")] }) }, NOW - HOUR)
		mkdirSync(join(agentDir, "work", "not-a-work"))

		const { rows } = await readWorkBrowser(agentDir, { workId: current, lines: [] }, NOW)

		expect(rows.map((row) => row.workId)).toEqual([current, newer, older])
		expect(rows[0].label).toBe("● 00000001 kimchi")
		expect(rows[1].label).toBe("  00000003 kimchi")
	})

	it("reads at most 30 works", async () => {
		for (let index = 1; index <= 35; index++)
			save(workId(index), { summary: summary(workId(index)) }, NOW - index * HOUR)

		const { rows } = await readWorkBrowser(agentDir, { workId: workId(35), lines: [] }, NOW)

		expect(rows).toHaveLength(30)
		expect(rows[0].workId).toBe(workId(35))
		expect(rows.map((row) => row.workId)).toContain(workId(29))
		expect(rows.map((row) => row.workId)).not.toContain(workId(30))
	})

	it("keeps the most recently active works when more works changed recently", async () => {
		const current = workId(1)
		save(current, { summary: summary(current) })
		// Background cost and PR updates rewrote these summaries after their last activity.
		for (let index = 2; index <= 30; index++)
			save(
				workId(index),
				{ summary: summary(workId(index), { requests: [request(`r${index}`, "2026-09-28T09:00:00Z")] }) },
				NOW - HOUR,
			)
		const active = workId(31)
		save(active, { summary: summary(active, { requests: [request("active", "2026-10-07T09:00:00Z")] }) }, NOW - DAY)

		const { rows } = await readWorkBrowser(agentDir, { workId: current, lines: [] }, NOW)

		expect(rows).toHaveLength(30)
		expect(rows[1].workId).toBe(active)
		expect(rows.map((row) => row.workId)).not.toContain(workId(30))
	})

	it("shows priced spend and never shows unpriced spend as $0", () => {
		const ids = [1, 2, 3, 4, 5, 6].map(workId)
		const { rows, spend } = browse([
			{
				workId: ids[0],
				summary: summary(ids[0], { requests: [request("a1"), request("a2")] }),
				costs: costs(ids[0], [
					{ requestId: "a1", usd: "0.031133200" },
					{ requestId: "a2", usd: "0.031133200" },
				]),
			},
			{
				workId: ids[1],
				summary: summary(ids[1], { requests: [request("b1"), request("b2")] }),
				costs: costs(ids[1], [
					{ requestId: "b1", usd: "0.012300000" },
					{ requestId: "b2", priced: false },
				]),
			},
			{
				workId: ids[2],
				summary: summary(ids[2], { requests: [request("c1")] }),
				costs: costs(ids[2], [{ requestId: "c1", priced: false }]),
			},
			// Requests recorded after the last cost pass are not priced yet.
			{
				workId: ids[3],
				summary: summary(ids[3], { requests: [request("d1"), request("d2")] }),
				costs: costs(ids[3], [{ requestId: "d1", usd: "1.234567890" }]),
			},
			{ workId: ids[4], summary: summary(ids[4]) },
			{
				workId: ids[5],
				summary: summary(ids[5], { requests: [request("f1")] }),
				costs: costs(ids[5], [{ requestId: "f1" }]),
			},
		])

		expect(Object.fromEntries(rows.map((row) => [row.workId, row.value]))).toEqual({
			[ids[0]]: "$0.0623 · no PR",
			[ids[1]]: "$0.0123 known so far · no PR",
			[ids[2]]: "cost unknown · no PR",
			[ids[3]]: "$1.23 known so far · no PR",
			[ids[4]]: "no requests · no PR",
			// A billed zero is a known price.
			[ids[5]]: "$0 · no PR",
		})
		expect(spend).toBe("$1.31 known so far")
		expect(rows.find((row) => row.workId === ids[1])?.description).toContain(
			"Prices: 1/2 requests priced, $0.012300000 USD known so far.",
		)
	})

	it("shows each connected work's own spend and counts their shared report once", () => {
		const [first, second] = [1, 2].map(workId)
		// The cost pass saves the whole connected group in each member's costs.json.
		const group = (id: string) =>
			costs(
				id,
				[
					{ requestId: "own", usd: "0.500000000", workIds: [first] },
					// A correction linked this planning request into the second work.
					{ requestId: "linked", usd: "0.250000000", workIds: [first], linkedWorkIds: [second] },
					{ requestId: "other", usd: "0.125000000", workIds: [second] },
				],
				[
					pullRequestCost({
						key: '["github","github.com","7"]',
						pullRequest: pullRequest(7, "merged"),
						workIds: [first, second],
						requestIds: ["own", "linked", "other"],
						knownCostUsd: "0.875000000",
						totalCostUsd: "0.875000000",
						explicit: {
							requestIds: ["own", "linked", "other"],
							knownCostUsd: "0.875000000",
							totalCostUsd: "0.875000000",
						},
					}),
				],
			)
		const { rows, spend } = browse([
			{
				workId: first,
				summary: summary(first, { requests: [request("own"), request("linked")] }),
				costs: group(first),
			},
			{ workId: second, summary: summary(second, { requests: [request("other")] }), costs: group(second) },
		])
		const row = (id: string) => rows.find((candidate) => candidate.workId === id)

		expect(row(first)?.value).toBe("$0.7500 · no PR")
		expect(row(second)?.value).toBe("$0.3750 · no PR")
		expect(row(first)?.description).toContain("Prices: 2/2 requests priced, $0.750000000 USD.")
		expect(row(second)?.description).toContain("Prices: 2/2 requests priced, $0.375000000 USD.")
		// The PR's total covers every contributing work.
		expect(row(second)?.description).toContain("Cost: $0.875000000 USD — https://github.com/example/kimchi/pull/7")
		// The header counts requests the group shares once, as deduplicating by request ID did.
		expect(spend).toBe("$0.8750")
	})

	it("shows each work's own spend while the saved reports repeat their connected works", () => {
		const [first, second] = [1, 2].map(workId)
		// The cost pass saves the whole connected group in each member's costs.json.
		const group = [
			{ requestId: "planning", usd: "0.500000000", workIds: [first] },
			{ requestId: "linked", usd: "0.250000000", workIds: [first], linkedWorkIds: [second] },
			{ requestId: "implementation", usd: "0.125000000", workIds: [second] },
		]
		const { rows, spend } = browse([
			{
				workId: first,
				summary: summary(first, { requests: [request("planning"), request("linked")] }),
				costs: costs(first, group),
			},
			{
				workId: second,
				summary: summary(second, { requests: [request("implementation")] }),
				costs: costs(second, group),
			},
		])

		expect(rows.map((row) => row.value.split(" · ")[0])).toEqual(["$0.7500", "$0.3750"])
		expect(spend).toBe("$0.8750")
	})

	it("counts a listed work's whole connected report in the header, unlisted works included", () => {
		const [listed, older] = [1, 2].map(workId)
		const { rows, spend } = browse([
			{
				workId: listed,
				summary: summary(listed, { requests: [request("listed")] }),
				costs: costs(listed, [
					{ requestId: "listed", usd: "0.500000000", workIds: [listed] },
					// A connected work too old to be listed.
					{ requestId: "older", usd: "0.125000000", workIds: [older] },
				]),
			},
		])

		expect(rows[0].value).toBe("$0.5000 · no PR")
		expect(spend).toBe("$0.6250")
	})

	it("names each work's PR state from its saved links", () => {
		const ids = [1, 2, 3, 4, 5].map(workId)
		const { rows } = browse(
			[
				{ workId: ids[0], summary: summary(ids[0], { commits: [commit("1", [pullRequest(731, "open")])] }) },
				{ workId: ids[1], summary: summary(ids[1], { commits: [commit("2", [])] }) },
				// A later observation of the same PR replaces the earlier one.
				{
					workId: ids[2],
					summary: summary(ids[2], {
						commits: [
							commit("3", [{ ...pullRequest(7, "open"), checkedAt: "2026-10-06T11:00:00Z" }]),
							commit("4", [pullRequest(7, "merged")]),
						],
					}),
				},
				{
					workId: ids[3],
					summary: summary(ids[3], {
						requests: [request("d1"), request("d2")],
						commits: [commit("5", [pullRequest(8, "merged"), pullRequest(9, "closed")])],
					}),
					costs: costs(ids[3], [{ requestId: "d1", usd: "0.012300000" }]),
				},
				{ workId: ids[4], summary: summary(ids[4], { commits: [commit("6", [pullRequest(12, "open", "gitlab")])] }) },
			],
			["PR/MR lookup: 1 commit waiting"],
		)
		const value = (id: string) => rows.find((row) => row.workId === id)?.value

		expect(value(ids[0])).toBe("no requests · PR #731 open")
		expect(value(ids[1])).toBe("no requests · no PR")
		expect(value(ids[2])).toBe("no requests · PR #7 merged")
		expect(value(ids[3])).toBe("$0.0123 known so far · 2 PRs")
		expect(value(ids[4])).toBe("no requests · MR !12 open")
		// The current work shows the PR extension's live lines; others show their saved links.
		expect(rows[0].details).toContain("PR/MR lookup: 1 commit waiting")
		expect(rows[0].details).not.toContain("pull/731")
		expect(rows.find((row) => row.workId === ids[3])?.details).toContain(
			"PR #8 merged: https://github.com/example/kimchi/pull/8\nPR #9 closed: https://github.com/example/kimchi/pull/9",
		)
	})

	it("labels work by its saved plan title, else by repository and branch", async () => {
		const [planned, edited, asked] = [1, 2, 3].map(workId)
		const planRecord = {
			sessionId: "session",
			path: "/src/kimchi/.kimchi/plans/csv.md",
			snapshotPath: `/old/agent/work/${planned}/plans/csv-abc.md`,
			recordedAt: "2026-10-08T08:00:00Z",
		}
		save(planned, {
			summary: summary(planned, { plans: [planRecord] }),
			plans: { "csv-abc.md": `<!-- kimchi-work-id: ${planned} -->\n# Add CSV\u001b[31m export\n\nSteps\n` },
		})
		save(edited, {
			summary: summary(edited, {
				requests: [request("e1")],
				fileTransitions: [
					{
						repository: "/src/kimchi/.git",
						worktree: "/src/kimchi-csv",
						branch: "main",
						recordedAt: "2026-10-07T08:00:00Z",
					},
					{
						repository: "/src/kimchi/.git",
						worktree: "/src/kimchi-csv",
						branch: "feat/csv",
						recordedAt: "2026-10-08T08:00:00Z",
					},
				],
			}),
		})
		save(asked, {
			summary: summary(asked, { requests: [{ ...request("a1"), scope: { repository: "/srv/app.git" } }] }),
		})

		const { rows } = await readWorkBrowser(agentDir, { workId: planned, lines: [] }, NOW)
		const label = (id: string) => rows.find((row) => row.workId === id)?.label

		expect(label(planned)).toBe("● 00000001 Add CSV export")
		expect(label(edited)).toBe("  00000002 kimchi · feat/csv")
		expect(label(asked)).toBe("  00000003 app")
	})

	it("keeps missing and damaged files visible as unknown", async () => {
		const [missing, damaged, wrongCosts] = [1, 2, 3].map(workId)
		save(damaged, { summary: "{", costs: costs(damaged, [{ requestId: "x1", usd: "0.100000000" }]) })
		save(wrongCosts, {
			summary: summary(wrongCosts, {
				requests: [request("y1")],
				plans: [{ sessionId: "session", path: "/gone.md", snapshotPath: "/gone/plans/missing.md" }],
			}),
			totals: '{"requests":"not a list"}',
		})

		const { rows, spend } = await readWorkBrowser(agentDir, { workId: missing, lines: [] }, NOW)
		const row = (id: string) => rows.find((candidate) => candidate.workId === id)

		// A damaged summary has no activity times, so its file time orders it.
		expect(rows.map((candidate) => candidate.workId)).toEqual([missing, damaged, wrongCosts])
		expect(row(missing)).toMatchObject({ label: "● 00000001 summary unavailable", value: "cost unknown · no PR" })
		expect(row(missing)?.description).toBe(
			[
				`Work ID: ${missing}`,
				`Summary unavailable: ${join(agentDir, "work", missing, "work.json")}`,
				"Cost: unknown; waiting for billing",
			].join("\n"),
		)
		expect(row(damaged)).toMatchObject({ label: "  00000002 summary unavailable", value: "$0.1000 · no PR" })
		expect(row(wrongCosts)).toMatchObject({ label: "  00000003 kimchi", value: "cost unknown · no PR" })
		expect(row(wrongCosts)?.description).toContain("Cost: unknown; waiting for billing")
		expect(spend).toBe("$0.1000 known so far")
	})

	it("labels an oversized version 1 summary as too large and keeps its PRs and partial spend", async () => {
		const id = workId(1)
		const pull = pullRequest(7, "open")
		const requests = Array.from({ length: 3600 }, (_, index) => ({
			...request(`r${index}`),
			billingRows: [{ id: `bill-${index}`, costUsd: "0.001", note: "x".repeat(2400) }],
		}))
		save(id, {
			summary: summary(id, { requests, commits: [commit("1", [pull])] }),
			costs: costs(
				id,
				[{ requestId: "r0", usd: "0.250000000" }],
				[
					pullRequestCost({
						key: '["github","github.com","7"]',
						pullRequest: pull,
						workIds: [id],
						knownCostUsd: "0.000000000",
						totalCostUsd: null,
					}),
				],
			),
		})
		expect(fs.statSync(join(agentDir, "work", id, "work.json")).size).toBeGreaterThan(8 * 1024 * 1024)

		const { rows } = await readWorkBrowser(agentDir, { workId: workId(2), lines: [] }, NOW)

		expect(rows[1]).toMatchObject({
			label: "  00000001 summary too large",
			// Requests newer than the last cost pass may be missing from the totals.
			value: "$0.2500 known so far · PR #7 open",
		})
		expect(rows[1].description).toContain(
			`Summary too large to list until the work's next update: ${join(agentDir, "work", id, "work.json")}`,
		)
		expect(rows[1].description).toContain("PR #7 open: https://github.com/example/kimchi/pull/7")
	})

	it("opens 30 long works from their manifests and cost totals alone", async () => {
		const ids = Array.from({ length: 30 }, (_, index) => workId(index + 1))
		for (const [index, id] of ids.entries()) {
			const folder = join(agentDir, "work", id)
			mkdirSync(join(folder, "rows"), { recursive: true })
			const manifest: WorkHead = {
				version: 2,
				workId: id,
				updatedAt: new Date(NOW).toISOString(),
				logs: { requests: { generation: 3, bytes: 33_441_207, rows: 15_000 } },
				latest: {
					activityAt: new Date(NOW - index * HOUR).toISOString(),
					request: { startedAt: new Date(NOW - index * HOUR).toISOString(), repository: "/src/kimchi/.git" },
					branch: { recordedAt: "2026-10-08T08:00:00Z", branch: "feat/search" },
				},
				pullRequests: [pullRequest(700 + index, "open")],
			}
			writeFileSync(join(folder, "work.json"), JSON.stringify(manifest))
			// The logs and the full report are large; the panel must not open them.
			writeFileSync(join(folder, "rows", "requests.3.jsonl"), "")
			writeFileSync(join(folder, "costs.json"), "")
			const priced = Array.from({ length: 14_990 }, (_, at) => ({ requestId: `${id}-${at}`, usd: "0.001000000" }))
			writeFileSync(join(folder, "cost-totals.json"), JSON.stringify(workCostTotals(costs(id, priced))))
		}
		const reads = vi.spyOn(asyncFs, "readFile")
		const opened = vi.spyOn(asyncFs, "open")

		const { rows, spend } = await readWorkBrowser(agentDir, { workId: ids[0], lines: [] }, NOW)

		expect(rows).toHaveLength(30)
		expect(rows[0].value).toBe("$14.99 known so far · PR #700 open")
		expect(rows[0].description).toContain("Repository: kimchi · branch feat/search")
		expect(rows[0].description).toContain("· 15000 requests")
		expect(spend).toBe("$449.70 known so far")
		const files = reads.mock.calls.map(([path]) => String(path))
		expect(files.every((path) => path.endsWith("work.json") || path.endsWith("cost-totals.json"))).toBe(true)
		expect(opened).not.toHaveBeenCalled()
	})

	it("describes a work with the details /work prints plus where and when it ran", async () => {
		const id = workId(1)
		save(id, {
			summary: summary(id, {
				requests: [request("r1", "2026-10-08T08:00:00Z"), request("r2", "2026-10-08T09:30:00Z")],
				fileTransitions: [{ repository: "/src/kimchi/.git", branch: "feat/csv", recordedAt: "2026-10-08T09:00:00Z" }],
			}),
			costs: costs(id, [{ requestId: "r1", usd: "0.031133200" }]),
		})
		const lines = ["PR #7 open: https://github.com/example/kimchi/pull/7"]

		const { rows } = await readWorkBrowser(agentDir, { workId: id, lines }, NOW)
		const printed = [`Work ID: ${id}`, ...lines, ...workCostDetails(agentDir, id)]

		expect(rows[0].details).toBe(printed.join("\n"))
		expect(rows[0].description).toBe(
			[
				printed[0],
				"Repository: kimchi · branch feat/csv",
				"Last activity: 2026-10-08 09:30 · 2 requests",
				...printed.slice(1),
			].join("\n"),
		)
	})

	it("explains unknown prices with the work's own untagged requests and failed refreshes only", () => {
		const [first, second] = [1, 2].map(workId)
		// The cost pass saves the whole connected group in each member's costs.json.
		const group = (id: string) => {
			const report = costs(id, [
				{ requestId: "planning", usd: "0.500000000", workIds: [first] },
				{ requestId: "untagged", priced: false, workIds: [second] },
			])
			Object.assign(report.requests[1], {
				billingTagSkipped: "tag-limit",
				billingLookup: {
					status: "unavailable",
					reason: "Billing lookup unavailable",
					checkedAt: "2026-10-08T10:00:00Z",
				},
			})
			return report
		}
		const { rows } = browse([
			{ workId: first, summary: summary(first, { requests: [request("planning")] }), costs: group(first) },
			{ workId: second, summary: summary(second, { requests: [request("untagged")] }), costs: group(second) },
		])
		const details = (id: string) => rows.find((row) => row.workId === id)?.details

		expect(details(first)).toContain("Prices: 1/1 requests priced, $0.500000000 USD.")
		expect(details(first)).not.toContain("untagged")
		expect(details(first)).not.toContain("Last billing refresh failed")
		expect(details(second)).toContain("Prices: 0/1 requests priced, $0.000000000 USD known so far.")
		expect(details(second)).toContain("1 request untagged: tag limit")
		expect(details(second)).toContain("Last billing refresh failed for 1 request: Billing lookup unavailable.")
	})
})
