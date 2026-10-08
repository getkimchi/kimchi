import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"
import { runCli } from "./accuracy-cli.js"
import { compareIndependentAttribution } from "./accuracy-reference.js"
import { calculatePullRequestCosts, type PullRequestCostReport } from "./costs.js"
import type { WorkRecord } from "./summary.js"

const root = mkdtempSync(join(tmpdir(), "kimchi-independent-accuracy-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const PR = "github:github.com/acme/api#7"
const OTHER = "github:github.com/acme/api#8"
const ACCOUNT = {
	apiUrl: "https://api.example.test",
	organizationId: "11111111-1111-4111-8111-111111111111",
	userId: "22222222-2222-4222-8222-222222222222",
}
const OTHER_ACCOUNT = { ...ACCOUNT, userId: "33333333-3333-4333-8333-333333333333" }
const MERGED_PR: WorkPullRequest = {
	provider: "github",
	host: "github.com",
	repository: "acme/api",
	number: 7,
	url: "https://github.com/acme/api/pull/7",
	state: "merged",
	headSha: "a".repeat(40),
	mergeCommitSha: "b".repeat(40),
	mergedAt: "2026-10-04T09:00:00Z",
	closedAt: "2026-10-04T09:00:00Z",
	checkedAt: "2026-10-04T11:00:00Z",
}
const empty = () => ({ requestIds: [], knownCostUsd: "0.000000000", totalCostUsd: "0.000000000" })

// The inventory, receipt and labels are fixed independently of the calculator.
function fixture() {
	const reference = {
		version: 1 as const,
		requests: [
			{
				requestId: "r1",
				account: ACCOUNT,
				costUsd: "1.000000001",
				expected: { kind: "pull-request", pullRequestId: PR },
			},
		],
	}
	const report: PullRequestCostReport = {
		requests: [
			{
				requestId: "r1",
				account: ACCOUNT,
				workIds: ["w1"],
				sessionIds: ["s1"],
				startedAt: "2026-10-04T08:00:00Z",
				billingRecordIds: ["b1"],
				allocation: "pull-request",
				pullRequestIds: [PR],
				priceStatus: "priced",
				knownCostUsd: "1.000000001",
				totalCostUsd: "1.000000001",
			},
		],
		pullRequests: [
			{
				key: PR,
				account: ACCOUNT,
				pullRequest: MERGED_PR,
				workIds: ["w1"],
				requestIds: ["r1"],
				sharedRequestIds: [],
				inferredRequestIds: [],
				unknownRequestIds: [],
				knownCostUsd: "1.000000001",
				totalCostUsd: "1.000000001",
				explicit: { requestIds: ["r1"], knownCostUsd: "1.000000001", totalCostUsd: "1.000000001" },
				inferred: empty(),
			},
		],
		unallocated: {
			inferred: empty(),
			shared: empty(),
			unlinked: empty(),
			unmerged: empty(),
			"post-merge": empty(),
			unknown: empty(),
		},
	}
	return { reference, report }
}

function compare(report: unknown, reference: unknown) {
	const reportPath = join(root, "report.json")
	const referencePath = join(root, "reference.json")
	writeFileSync(reportPath, JSON.stringify(report))
	writeFileSync(referencePath, JSON.stringify(reference))
	return runCli([reportPath, referencePath])
}

describe("sure and likely report totals", () => {
	function reportFor(pullRequest: WorkPullRequest = MERGED_PR) {
		const records: WorkRecord[] = [
			...(["explicit", "session"] as const).map((attribution, index) => ({
				version: 1 as const,
				type: "request" as const,
				workId: "work",
				sessionId: "session",
				requestId: `r${index + 1}`,
				recordedAt: "2026-10-04T08:00:00Z",
				scope: { account: ACCOUNT, repository: "/repo/.git" },
				segment: { id: attribution, attribution, reason: "fixture" },
			})),
			{
				version: 1,
				type: "commit",
				workId: "work",
				sessionId: "session",
				repository: "/repo/.git",
				worktree: "/repo",
				sha: "a".repeat(40),
				pullRequests: [pullRequest],
			},
		]
		return calculatePullRequestCosts(records, [
			{ requestId: "r1", billingRecordId: "b1", account: ACCOUNT, costUsd: "0.100000001" },
			{ requestId: "r2", billingRecordId: "b2", account: ACCOUNT, costUsd: "0.200000002" },
		])
	}
	const reference = {
		version: 1 as const,
		requests: [
			{
				requestId: "r1",
				account: ACCOUNT,
				costUsd: "0.100000001",
				expected: { kind: "pull-request", pullRequestId: PR },
			},
			{
				requestId: "r2",
				account: ACCOUNT,
				costUsd: "0.200000002",
				expected: { kind: "pull-request", pullRequestId: PR },
			},
		],
	}

	it("counts likely spend once in the headline while keeping confirmed coverage separate", () => {
		const report = reportFor()
		expect(report.pullRequests[0]).toMatchObject({
			totalCostUsd: "0.300000003",
			explicit: { totalCostUsd: "0.100000001" },
			inferred: { totalCostUsd: "0.200000002" },
		})
		const result = compareIndependentAttribution(report, reference)
		expect(result).toMatchObject({ complete: true, matches: false, sumAbsolutePullRequestErrorUsd: "0.000000000" })
		expect(result.comparison.correct.requestIds).toEqual(["r1"])
		expect(result.comparison.missed.requestIds).toEqual(["r2"])
		expect(result.differences).toEqual([expect.objectContaining({ kind: "ownership-mismatch", requestId: "r2" })])
	})

	it.each([
		"explicit",
		"inferred",
	] as const)("detects a wrong %s portion even when the headline is correct", (portion) => {
		const report = reportFor()
		report.pullRequests[0][portion].knownCostUsd = report.pullRequests[0][portion].totalCostUsd = "0"
		const result = compareIndependentAttribution(report, reference)
		expect(result.differences).toContainEqual(
			expect.objectContaining({ kind: "aggregate-mismatch", detail: expect.stringContaining(`.${portion}:`) }),
		)
	})

	it("cannot certify a report that omits a confidence portion", () => {
		const report = reportFor()
		const { inferred: _missing, ...pull } = report.pullRequests[0]
		expect(compareIndependentAttribution({ ...report, pullRequests: [pull] }, reference).complete).toBe(false)
	})

	it.each(["github", "gitlab"] as const)("accepts the %s provider identity used by the calculator", (provider) => {
		const key = JSON.stringify([provider, `${provider}.com`, "12345"])
		const pull: WorkPullRequest = {
			...MERGED_PR,
			provider,
			host: `${provider}.com`,
			id: "12345",
			repositoryId: "54321",
			url: `https://${provider}.com/acme/api/${provider === "github" ? "pull" : "-/merge_requests"}/7`,
		}
		const report = reportFor(pull)
		const refs = {
			...reference,
			requests: reference.requests.map((row) => ({ ...row, expected: { kind: "pull-request", pullRequestId: key } })),
		}
		const result = compareIndependentAttribution(report, refs)
		expect(result).toMatchObject({ complete: true, sumAbsolutePullRequestErrorUsd: "0.000000000" })
		expect(result.problems).toEqual([])
		expect(result.differences).toEqual([expect.objectContaining({ kind: "ownership-mismatch", requestId: "r2" })])
	})

	it.each([
		'["github","github.com"]',
		'["github","github.com","0"]',
		'["github","github.com",12345]',
		'["github","user@github.com","12345"]',
		'["gitlab","gitlab.com/path","12345"]',
	])("rejects a malformed provider identity %s", (key) => {
		const { report, reference } = fixture()
		report.requests[0].pullRequestIds = [key]
		report.pullRequests[0].key = key
		reference.requests[0].expected.pullRequestId = key
		expect(compare(report, reference).code).toBe(2)
	})
})

describe("independent accuracy reference", () => {
	it("checks independently inventoried requests, prices, labels and full report totals", () => {
		const { report, reference } = fixture()
		const result = compare(report, reference)
		expect(result.code).toBe(0)
		expect(result.stdout.join("\n")).toContain("Independent reference: 1 requests; 1.000000001 known USD")
		expect(result.stdout).toContain("Sum of absolute PR errors: 0.000000000 USD")
	})

	it("detects a wrong billed price even when the allocation and report sums agree", () => {
		const { report, reference } = fixture()
		report.requests[0].knownCostUsd = report.requests[0].totalCostUsd = "2.000000001"
		report.pullRequests[0].knownCostUsd = report.pullRequests[0].totalCostUsd = "2.000000001"
		const result = compare(report, reference)
		expect(result.code).toBe(3)
		expect(result.stdout.join("\n")).toContain("[price-mismatch] r1")
		expect(result.stdout).toContain("Sum of absolute PR errors: 1.000000000 USD")
	})

	it.each([
		undefined,
		null,
		{},
		1,
		"broken",
		"0.0000000001",
		"-1",
	])("treats malformed priced request totalCostUsd %j as incomplete evidence", (totalCostUsd) => {
		const { report, reference } = fixture()
		const result = compare({ ...report, requests: [{ ...report.requests[0], totalCostUsd }] }, reference)
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[invalid-report-row] r1")
		expect(result.stdout.join("\n")).toContain("totalCostUsd")
		expect(result.stdout).toContain("Percentages: full percentages unavailable (comparison incomplete)")
		expect(result.stdout.join("\n")).not.toContain("100.000000000%")
	})

	it("identifies the differing final request price when the known amount is correct", () => {
		const { report, reference } = fixture()
		report.requests[0].totalCostUsd = "2.000000001"
		const result = compare(report, reference)
		expect(result.code).toBe(3)
		expect(result.stdout.join("\n")).toContain(
			"reported totalCostUsd 2.000000001 USD; independent receipt 1.000000001 USD",
		)
	})

	it("catches a tampered PR total despite correct per-request assignments", () => {
		const { report, reference } = fixture()
		report.pullRequests[0].knownCostUsd = report.pullRequests[0].totalCostUsd = "9.000000001"
		const result = compare(report, reference)
		expect(result.code).toBe(3)
		expect(result.stdout.join("\n")).toContain("[aggregate-mismatch]")
		expect(result.stdout).toContain("Sum of absolute PR errors: 8.000000000 USD")
	})

	it("does not let equal overcounts and undercounts on different PRs cancel", () => {
		const { report, reference } = fixture()
		reference.requests.push({
			requestId: "r2",
			account: ACCOUNT,
			costUsd: "1.000000001",
			expected: { kind: "pull-request", pullRequestId: OTHER },
		})
		report.requests.push({ ...report.requests[0], requestId: "r2", pullRequestIds: [OTHER] })
		report.pullRequests.push({
			...report.pullRequests[0],
			key: OTHER,
			requestIds: ["r2"],
			knownCostUsd: "0.000000001",
			totalCostUsd: "0.000000001",
		})
		report.pullRequests[0].knownCostUsd = report.pullRequests[0].totalCostUsd = "2.000000001"
		const result = compare(report, reference)
		expect(result.code).toBe(3)
		expect(result.stdout).toContain(
			`PR ${PR} [${ACCOUNT.apiUrl}; organization ${ACCOUNT.organizationId}; user ${ACCOUNT.userId}]: reported 2.000000001 USD; expected 1.000000001 USD; error +1.000000000 USD`,
		)
		expect(result.stdout).toContain(
			`PR ${OTHER} [${ACCOUNT.apiUrl}; organization ${ACCOUNT.organizationId}; user ${ACCOUNT.userId}]: reported 0.000000001 USD; expected 1.000000001 USD; error -1.000000000 USD`,
		)
		expect(result.stdout).toContain("Sum of absolute PR errors: 2.000000000 USD")
	})

	it("detects a request missing from capture using the independent inventory", () => {
		const { report, reference } = fixture()
		reference.requests.push({
			requestId: "r-missing",
			account: ACCOUNT,
			costUsd: "4.000000000",
			expected: { kind: "pull-request", pullRequestId: PR },
		})
		const result = compare(report, reference)
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[missing-report-row] r-missing")
	})

	it("does not silently drop an observed request missing from the reference", () => {
		const { report, reference } = fixture()
		reference.requests = []
		const result = compare(report, reference)
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[unlabelled-request] r1")
	})

	it.each([
		null,
		"1.0000000001",
		-1,
	])("keeps an unknown or invalid independent price (%s) out of a complete score", (costUsd) => {
		const { report, reference } = fixture()
		const result = compare(report, { ...reference, requests: [{ ...reference.requests[0], costUsd }] })
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[unpriced-reference] r1")
	})

	it("keeps unknown human ownership separate from deliberately unassigned work", () => {
		const { report, reference } = fixture()
		const result = compare(report, {
			...reference,
			requests: [{ ...reference.requests[0], expected: { kind: "unknown" } }],
		})
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[unknown-reference] r1")
	})

	it("scores shared ownership without splitting its price across PRs", () => {
		const { report, reference } = fixture()
		report.requests[0].allocation = "shared"
		report.requests[0].pullRequestIds = [PR, OTHER]
		report.pullRequests = [PR, OTHER].map((key) => ({
			...report.pullRequests[0],
			key,
			requestIds: [],
			sharedRequestIds: ["r1"],
			unknownRequestIds: [],
			knownCostUsd: "0.000000000",
			totalCostUsd: null,
			explicit: empty(),
		}))
		report.unallocated.shared = { requestIds: ["r1"], knownCostUsd: "1.000000001", totalCostUsd: "1.000000001" }
		const refs = {
			...reference,
			requests: [{ ...reference.requests[0], expected: { kind: "shared", pullRequestIds: [OTHER, PR] } }],
		}
		expect(compare(report, refs).code).toBe(0)
		report.requests[0].pullRequestIds = [PR]
		expect(compare(report, refs).code).toBe(3)
	})

	it("does not treat post-merge and unrelated spending as the same expected bucket", () => {
		const { report, reference } = fixture()
		report.requests[0].allocation = "post-merge"
		report.pullRequests = []
		report.unallocated["post-merge"] = { requestIds: ["r1"], knownCostUsd: "1.000000001", totalCostUsd: "1.000000001" }
		const refs = {
			...reference,
			requests: [{ ...reference.requests[0], expected: { kind: "no-pr", reason: "post-merge" } }],
		}
		expect(compare(report, refs).code).toBe(0)
		report.unallocated.unlinked = report.unallocated["post-merge"]
		report.unallocated["post-merge"] = empty()
		expect(compare(report, refs).code).toBe(3)
	})

	it("rejects duplicated independent labels instead of weighting that request twice", () => {
		const { report, reference } = fixture()
		reference.requests.push({ ...reference.requests[0] })
		const result = compare(report, reference)
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[duplicate-label] r1")
	})

	it("distinguishes conflicting shared labels from identical duplicates", () => {
		const { report, reference } = fixture()
		const result = compare(report, {
			version: 1,
			requests: [
				{ ...reference.requests[0], expected: { kind: "shared", pullRequestIds: [PR, OTHER] } },
				{ ...reference.requests[0], expected: { kind: "no-pr" } },
			],
		})
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[conflicting-labels] r1")
	})

	it("treats different receipt amounts for the same request as conflicting evidence", () => {
		const { report, reference } = fixture()
		reference.requests.push({ ...reference.requests[0], costUsd: "2.000000000" })
		const result = compare(report, reference)
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[conflicting-labels] r1")
	})

	it("prints dollar and request metrics with their denominators", () => {
		const { report, reference } = fixture()
		const result = compare(report, reference)
		expect(result.stdout.join("\n")).toContain(
			"Correct coverage: 100.000000000% of spending; 100.000000000% of requests",
		)
		expect(result.stdout.join("\n")).toContain("Wrong assignment: 0.000000000% of spending; 0.000000000% of requests")
	})

	it("does not let a zero-priced request disappear from count-based accuracy", () => {
		const { report, reference } = fixture()
		reference.requests[0].costUsd = "0.000000000"
		report.requests[0].knownCostUsd = report.requests[0].totalCostUsd = "0.000000000"
		report.pullRequests[0].knownCostUsd = report.pullRequests[0].totalCostUsd = "0.000000000"
		report.pullRequests[0].explicit.knownCostUsd = report.pullRequests[0].explicit.totalCostUsd = "0.000000000"
		const result = compare(report, reference)
		expect(result.code).toBe(0)
		expect(result.stdout.join("\n")).toContain(
			"Correct coverage: n/a (zero spending denominator); 100.000000000% of requests",
		)
	})

	it("rejects malformed ownership fields in a no-PR row instead of scoring it as correct", () => {
		const { report, reference } = fixture()
		const malformed = {
			...report,
			requests: [{ ...report.requests[0], allocation: "unlinked", pullRequestIds: null }],
			pullRequests: [],
			unallocated: {
				...report.unallocated,
				unlinked: { requestIds: ["r1"], knownCostUsd: "1.000000001", totalCostUsd: "1.000000001" },
			},
		}
		const result = compare(malformed, {
			version: 1,
			requests: [{ ...reference.requests[0], expected: { kind: "no-pr" } }],
		})
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[invalid-report-row]")
	})

	it("allows an open PR with no exclusive costs to retain an unknown final total", () => {
		const { report, reference } = fixture()
		report.requests[0].allocation = "unmerged"
		report.pullRequests[0] = {
			...report.pullRequests[0],
			pullRequest: { ...MERGED_PR, state: "open", mergedAt: null, closedAt: null },
			requestIds: [],
			knownCostUsd: "0.000000000",
			totalCostUsd: null,
			explicit: empty(),
		}
		report.unallocated.unmerged = { requestIds: ["r1"], knownCostUsd: "1.000000001", totalCostUsd: "1.000000001" }
		const result = compare(report, {
			version: 1,
			requests: [{ ...reference.requests[0], expected: { kind: "no-pr", reason: "unmerged" } }],
		})
		expect(result.code).toBe(0)
	})

	it.each([
		"open",
		"closed",
		"merged",
	] as const)("checks an empty %s PR total against provider state instead of copying the tested amount", (state) => {
		const pullRequest: WorkPullRequest = {
			...MERGED_PR,
			state,
			mergedAt: state === "merged" ? MERGED_PR.mergedAt : null,
			closedAt: state === "open" ? null : MERGED_PR.closedAt,
		}
		const records: WorkRecord[] = [
			{
				version: 1,
				type: "request",
				workId: "work",
				sessionId: "session",
				requestId: "r1",
				recordedAt: "2026-10-04T10:00:00Z",
				scope: { repository: "/repo/.git", account: ACCOUNT },
			},
			{
				version: 1,
				type: "commit",
				workId: "work",
				sessionId: "session",
				recordedAt: "2026-10-04T10:30:00Z",
				repository: "/repo/.git",
				worktree: "/repo",
				sha: "a".repeat(40),
				pullRequests: [pullRequest],
			},
		]
		const report = calculatePullRequestCosts(records, [
			{ requestId: "r1", billingRecordId: "b1", costUsd: "1.000000001", account: ACCOUNT },
		])
		const reference = {
			version: 1 as const,
			requests: [
				{
					requestId: "r1",
					account: ACCOUNT,
					costUsd: "1.000000001",
					expected: { kind: "no-pr", reason: state === "merged" ? "post-merge" : "unmerged" },
				},
			],
		}
		expect(report.pullRequests[0].requestIds).toEqual([])
		expect(compareIndependentAttribution(report, reference)).toMatchObject({ complete: true, matches: true })
		report.pullRequests[0].totalCostUsd = state === "merged" ? null : "0.000000000"
		const result = compareIndependentAttribution(report, reference)
		expect(result).toMatchObject({ complete: true, matches: false })
		expect(result.differences).toContainEqual(expect.objectContaining({ kind: "aggregate-mismatch" }))
		expect(compare(report, reference).code).toBe(3)
	})

	it.each([
		{ state: "open", costUsd: "1.000000001" },
		{ state: "closed", costUsd: "1.000000001" },
		{ state: "open", costUsd: "0.000000000" },
		{ state: "closed", costUsd: "0.000000000" },
	] as const)("keeps the independently confirmed $costUsd final amount when reported state changes to $state", ({
		state,
		costUsd,
	}) => {
		const { report, reference } = fixture()
		reference.requests[0].costUsd = costUsd
		report.requests[0].knownCostUsd = report.requests[0].totalCostUsd = costUsd
		report.pullRequests[0].knownCostUsd = report.pullRequests[0].totalCostUsd = costUsd
		report.pullRequests[0].explicit.knownCostUsd = report.pullRequests[0].explicit.totalCostUsd = costUsd
		expect(compare(report, reference).code).toBe(0)
		report.pullRequests[0].pullRequest = {
			...MERGED_PR,
			state,
			mergedAt: null,
			closedAt: null,
			mergeCommitSha: null,
		}
		report.pullRequests[0].totalCostUsd = null
		const result = compareIndependentAttribution(report, reference)
		expect(result).toMatchObject({ complete: true, matches: false })
		expect(result.differences).toContainEqual(expect.objectContaining({ kind: "aggregate-mismatch" }))
		expect(compare(report, reference).code).toBe(3)
	})

	it("rejects duplicate request membership in aggregate totals", () => {
		const { report, reference } = fixture()
		report.pullRequests[0].requestIds.push("r1")
		const result = compare(report, reference)
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[invalid-aggregate]")
	})

	it("does not display an unknown independent price as a zero-dollar PR expectation", () => {
		const { report, reference } = fixture()
		const result = compare(report, { version: 1, requests: [{ ...reference.requests[0], costUsd: null }] })
		expect(result.code).toBe(2)
		expect(result.stdout).toContain(
			`PR ${PR} [${ACCOUNT.apiUrl}; organization ${ACCOUNT.organizationId}; user ${ACCOUNT.userId}]: reported 1.000000001 USD; expected unknown; error unknown`,
		)
		expect(result.stdout).toContain("Sum of absolute PR errors: unavailable (comparison incomplete)")
	})

	it("weights wrong-assignment spending by independent prices, not incorrect report prices", () => {
		const { report, reference } = fixture()
		reference.requests[0].costUsd = "1.000000000"
		reference.requests.push({
			requestId: "r2",
			account: ACCOUNT,
			costUsd: "3.000000000",
			expected: { kind: "pull-request", pullRequestId: PR },
		})
		report.requests[0].knownCostUsd = report.requests[0].totalCostUsd = "9.000000000"
		report.requests.push({
			...report.requests[0],
			requestId: "r2",
			pullRequestIds: [OTHER],
			knownCostUsd: "1.000000000",
			totalCostUsd: "1.000000000",
		})
		const result = compare(report, reference)
		expect(result.code).toBe(3)
		expect(result.stdout.join("\n")).toContain("Wrong assignment: 75.000000000% of spending; 50.000000000% of requests")
	})

	it.each([
		null,
		{ version: 2, requests: [] },
		{ version: 1, requests: {} },
	])("rejects an unsupported reference shape %j", (reference) => {
		const { report } = fixture()
		expect(compare(report, reference).code).toBe(1)
	})

	it("rejects a report with missing aggregate buckets rather than silently ignoring them", () => {
		const { report, reference } = fixture()
		const result = compare({ requests: report.requests }, reference)
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[invalid-aggregate]")
	})
})

describe("account-scoped independent accuracy", () => {
	it.each([
		OTHER_ACCOUNT,
		{ ...ACCOUNT, organizationId: "44444444-4444-4444-8444-444444444444" },
		{ ...ACCOUNT, apiUrl: "https://other-api.example.test" },
	])("keeps the same canonical PR separate for account %j", (account) => {
		const { report, reference } = fixture()
		reference.requests.push({ ...reference.requests[0], requestId: "r2", account, costUsd: "2.000000002" })
		report.requests.push({
			...report.requests[0],
			requestId: "r2",
			account,
			knownCostUsd: "2.000000002",
			totalCostUsd: "2.000000002",
		})
		report.pullRequests.push({
			...report.pullRequests[0],
			account,
			requestIds: ["r2"],
			knownCostUsd: "2.000000002",
			totalCostUsd: "2.000000002",
			explicit: { requestIds: ["r2"], knownCostUsd: "2.000000002", totalCostUsd: "2.000000002" },
		})
		const result = compareIndependentAttribution(report, reference)
		expect(result).toMatchObject({ complete: true, matches: true, sumAbsolutePullRequestErrorUsd: "0.000000000" })
		expect(result.pullRequests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: PR, account: ACCOUNT, reportedCostUsd: "1.000000001" }),
				expect.objectContaining({ key: PR, account, reportedCostUsd: "2.000000002" }),
			]),
		)
		expect(result.pullRequests).toHaveLength(2)
	})

	it("scores a confirmed assignment under the wrong account as wrong and missed", () => {
		const { report, reference } = fixture()
		report.requests[0].account = OTHER_ACCOUNT
		report.pullRequests[0].account = OTHER_ACCOUNT
		const result = compareIndependentAttribution(report, reference)
		expect(result).toMatchObject({ complete: true, matches: false, sumAbsolutePullRequestErrorUsd: "2.000000002" })
		expect(result.differences).toContainEqual(expect.objectContaining({ kind: "account-mismatch", requestId: "r1" }))
		expect(result.comparison.correct.requestIds).toEqual([])
		expect(result.comparison.wrong.requestIds).toEqual(["r1"])
		expect(result.comparison.missed.requestIds).toEqual(["r1"])
		expect(result.comparison.metrics).toEqual({
			correctCoveragePercent: "0.000000000",
			wrongAssignmentPercent: "100.000000000",
		})
	})

	it.each([
		undefined,
		null,
		{},
		{ ...ACCOUNT, userId: "not-a-uuid" },
		{ ...ACCOUNT, apiUrl: "" },
		{ ...ACCOUNT, apiUrl: "https://secret@example.test" },
	])("does not borrow missing or malformed reference account %j from the report", (account) => {
		const { report, reference } = fixture()
		const result = compare(report, { ...reference, requests: [{ ...reference.requests[0], account }] })
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[unverified-reference-account] r1")
		// The human label still counts; only its receipt lacks account evidence.
		expect(result.stdout.join("\n")).not.toContain("[unlabelled-request]")
		expect(result.stdout).toContain("Sum of absolute PR errors: unavailable (comparison incomplete)")
	})

	it("does not qualify a legacy request whose account is absent", () => {
		const { report, reference } = fixture()
		const { account: _account, ...legacy } = report.requests[0]
		const result = compare({ ...report, requests: [legacy] }, reference)
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[unverified-report-account] r1")
	})

	it("rejects a PR aggregate with no verified account", () => {
		const { report, reference } = fixture()
		report.pullRequests[0].account = null
		const result = compare(report, reference)
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[invalid-aggregate]")
	})

	it("still rejects repeated totals for the same account and PR", () => {
		const { report, reference } = fixture()
		report.pullRequests.push({ ...report.pullRequests[0] })
		const result = compare(report, reference)
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("duplicate PR total")
	})

	it("treats two account claims for one reference request as conflicting evidence", () => {
		const { report, reference } = fixture()
		reference.requests.push({ ...reference.requests[0], account: OTHER_ACCOUNT })
		const result = compare(report, reference)
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[conflicting-labels] r1")
	})

	it("excludes a request from scoring when a repeated entry lacks account evidence", () => {
		const { report, reference } = fixture()
		const result = compareIndependentAttribution(report, {
			version: 1,
			requests: [reference.requests[0], { ...reference.requests[0], account: null }],
		})
		expect(result.complete).toBe(false)
		expect(result.problems).toContainEqual(expect.objectContaining({ kind: "conflicting-labels", requestId: "r1" }))
		expect(result.comparison.correct.requestIds).toEqual([])
	})
})

describe("inferred report bookkeeping", () => {
	function inferredFixture() {
		const { report, reference } = fixture()
		report.requests[0].allocation = "inferred"
		report.pullRequests[0] = {
			...report.pullRequests[0],
			inferredRequestIds: ["r1"],
			explicit: empty(),
			inferred: { requestIds: ["r1"], knownCostUsd: "1.000000001", totalCostUsd: "1.000000001" },
		}
		report.unallocated.inferred = { requestIds: ["r1"], knownCostUsd: "1.000000001", totalCostUsd: "1.000000001" }
		return { report, reference }
	}

	it("keeps an exact inferred price outside confirmed assignment coverage", () => {
		const { report, reference } = inferredFixture()
		const result = compareIndependentAttribution(report, reference)
		expect(result).toMatchObject({ complete: true, matches: false, sumAbsolutePullRequestErrorUsd: "0.000000000" })
		expect(result.problems).toEqual([])
		expect(result.comparison.assigned.requestIds).toEqual([])
		expect(result.comparison.correct.requestIds).toEqual([])
		expect(result.comparison.missed.requestIds).toEqual(["r1"])
		expect(result.comparison.coverage.scoredRequests).toBe(1)
		expect(result.comparison.metrics.correctCoveragePercent).toBe("0.000000000")
		expect(result.differences.some((problem) => problem.detail.startsWith("inferred:"))).toBe(false)
	})

	it("checks an inferred bucket even when the independent label expects a PR", () => {
		const { report, reference } = inferredFixture()
		report.unallocated.inferred = empty()
		const result = compareIndependentAttribution(report, reference)
		expect(result.differences).toContainEqual(
			expect.objectContaining({ kind: "aggregate-mismatch", detail: expect.stringContaining("inferred:") }),
		)
	})

	it.each(["missing", "wrong-account", "extra"])("checks %s inferred candidate membership", (change) => {
		const { report, reference } = inferredFixture()
		if (change === "missing") report.pullRequests[0].inferredRequestIds = []
		if (change === "wrong-account") report.pullRequests[0].account = OTHER_ACCOUNT
		if (change === "extra") report.pullRequests[0].inferredRequestIds.push("not-in-report")
		const result = compareIndependentAttribution(report, reference)
		expect(result.differences).toContainEqual(
			expect.objectContaining({
				kind: "aggregate-mismatch",
				detail: expect.stringContaining("inferred request membership"),
			}),
		)
	})

	it("does not hide a missing inferred bucket", () => {
		const { report, reference } = inferredFixture()
		const { inferred: _inferred, ...unallocated } = report.unallocated
		expect(compare({ ...report, unallocated }, reference).code).toBe(2)
	})

	it("keeps free inferred requests visible in request coverage", () => {
		const { report, reference } = inferredFixture()
		reference.requests[0].costUsd = "0"
		report.requests[0].knownCostUsd = report.requests[0].totalCostUsd = "0"
		report.unallocated.inferred.knownCostUsd = report.unallocated.inferred.totalCostUsd = "0"
		report.pullRequests[0].knownCostUsd = report.pullRequests[0].totalCostUsd = "0"
		report.pullRequests[0].inferred.knownCostUsd = report.pullRequests[0].inferred.totalCostUsd = "0"
		const result = compareIndependentAttribution(report, reference)
		expect(result).toMatchObject({ complete: true, matches: false, sumAbsolutePullRequestErrorUsd: "0.000000000" })
		expect(result.comparison.missed.requestIds).toEqual(["r1"])
		expect(result.comparison.requestMetrics.correctCoveragePercent).toBe("0.000000000")
	})

	it("checks each candidate in its account while counting one inferred charge once", () => {
		const { report, reference } = inferredFixture()
		report.requests[0].pullRequestIds = [PR, OTHER]
		report.pullRequests[0] = {
			...report.pullRequests[0],
			requestIds: [],
			knownCostUsd: "0.000000000",
			totalCostUsd: null,
			inferred: empty(),
		}
		report.requests.push({
			...report.requests[0],
			requestId: "r2",
			account: OTHER_ACCOUNT,
			pullRequestIds: [PR],
			knownCostUsd: "2.000000002",
			totalCostUsd: "2.000000002",
		})
		report.pullRequests.push(
			{ ...report.pullRequests[0], key: OTHER },
			{
				...report.pullRequests[0],
				account: OTHER_ACCOUNT,
				requestIds: ["r2"],
				inferredRequestIds: ["r2"],
				knownCostUsd: "2.000000002",
				totalCostUsd: "2.000000002",
				inferred: { requestIds: ["r2"], knownCostUsd: "2.000000002", totalCostUsd: "2.000000002" },
			},
		)
		report.unallocated.inferred = {
			requestIds: ["r1", "r2"],
			knownCostUsd: "3.000000003",
			totalCostUsd: "3.000000003",
		}
		reference.requests.push({
			...reference.requests[0],
			requestId: "r2",
			account: OTHER_ACCOUNT,
			costUsd: "2.000000002",
		})
		const before = JSON.stringify({ report, reference })
		const result = compareIndependentAttribution(report, reference)
		expect(result).toMatchObject({ complete: true, matches: false, sumAbsolutePullRequestErrorUsd: "1.000000001" })
		expect(result.pullRequests).toHaveLength(3)
		expect(result.comparison.assigned.requestIds).toEqual([])
		expect(result.comparison.missed.requestIds).toEqual(["r1", "r2"])
		expect(result.differences.some((difference) => difference.detail.includes("inferred request membership"))).toBe(
			false,
		)
		expect(result.differences.some((difference) => difference.detail.startsWith("inferred:"))).toBe(false)
		expect(JSON.stringify({ report, reference })).toBe(before)
	})

	it.each([
		{ pullRequestIds: [] },
		{ pullRequestIds: ["github:acme/api#7"] },
	])("rejects inferred rows with incomplete candidate identities %j", ({ pullRequestIds }) => {
		const { report, reference } = inferredFixture()
		report.requests[0].pullRequestIds = pullRequestIds
		const result = compare(report, reference)
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[invalid-report-row] r1")
	})

	it("does not use an inferred candidate to fill an unknown human label", () => {
		const { report, reference } = inferredFixture()
		const result = compare(report, {
			...reference,
			requests: [{ ...reference.requests[0], expected: { kind: "unknown" } }],
		})
		expect(result.code).toBe(2)
		expect(result.stdout.join("\n")).toContain("[unknown-reference] r1")
		expect(result.stdout).toContain("Percentages: full percentages unavailable (comparison incomplete)")
	})
})
