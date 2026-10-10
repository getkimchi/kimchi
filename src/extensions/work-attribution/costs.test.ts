import { describe, expect, it } from "vitest"
import { createWorkScopeSnapshot } from "../__mocks__/work-scope.js"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"
import { calculatePullRequestCosts, type RequestCostObservation } from "./costs.js"
import type { WorkRecord } from "./summary.js"

const time = (minutes: number) => new Date(Date.UTC(2026, 9, 2, 10, minutes)).toISOString()
const testScope = createWorkScopeSnapshot("/repo/.git").scope

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
	pullRequests = [pullRequest()],
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

function charge(requestId: string, costUsd: string | null, billingRecordId = requestId): RequestCostObservation {
	return { requestId, billingRecordId, costUsd, account: testScope.account }
}

const secondPull = () => pullRequest({ number: 2, url: "https://github.com/example/repository/pull/2" })

describe("account-scoped PR totals", () => {
	it("retains stable provider IDs and rejects equally recent contradictory IDs", () => {
		const first = commit("work-a", [pullRequest({ id: "81", repositoryId: "42" })])
		expect(calculatePullRequestCosts([request("a"), first], []).pullRequests[0].pullRequest).toMatchObject({
			id: "81",
			repositoryId: "42",
		})
		const conflicting = commit("work-a", [pullRequest({ id: "81", repositoryId: "43" })])
		expect(calculatePullRequestCosts([request("a"), first, conflicting], []).pullRequests[0].pullRequest).toBeNull()
	})
	it.each(["organizationId", "userId", "apiUrl"] as const)("separates the same PR by %s", (field) => {
		const scope = createWorkScopeSnapshot("/repo/.git").scope
		const other = {
			...scope,
			account: {
				...scope.account,
				[field]: field === "apiUrl" ? "https://other.example/api" : "50000000-0000-4000-8000-000000000005",
			},
		}
		const records = [
			request("a", "work-a", "session-a", time(10), { scope }),
			request("b", "work-b", "session-b", time(10), { scope: other }),
			commit(),
			commit("work-b"),
		]
		const prices = [
			{ ...charge("a", "1"), account: scope.account },
			{ ...charge("b", "2"), account: other.account },
		]
		const report = calculatePullRequestCosts(records, prices)
		expect(report.pullRequests).toHaveLength(2)
		for (const [index, account] of [scope.account, other.account].entries())
			expect(
				report.pullRequests.find(
					(row) =>
						row.account?.userId === account.userId &&
						row.account?.organizationId === account.organizationId &&
						row.account?.apiUrl === account.apiUrl,
				),
			).toMatchObject({
				key: "github:github.com/example/repository#1",
				account,
				workIds: [index === 0 ? "work-a" : "work-b"],
				requestIds: [index === 0 ? "a" : "b"],
				totalCostUsd: `${index + 1}.000000000`,
			})
		expect(calculatePullRequestCosts(records.toReversed(), prices.toReversed())).toEqual(report)
	})

	it("keeps legacy requests unassigned even when their exact billing accounts are known", () => {
		const account = createWorkScopeSnapshot().scope.account
		const report = calculatePullRequestCosts(
			[
				request("a", undefined, undefined, undefined, { scope: undefined }),
				request("b", undefined, undefined, undefined, { scope: undefined }),
				commit(),
			],
			[
				{ ...charge("a", "1"), account },
				{ ...charge("b", "2"), account: { ...account, userId: "50000000-0000-4000-8000-000000000005" } },
			],
		)
		expect(report.requests.map((row) => [row.allocation, row.reason, row.totalCostUsd])).toEqual([
			["unknown", "work-account-unverified", "1.000000000"],
			["unknown", "work-account-unverified", "2.000000000"],
		])
		expect(report.pullRequests[0]).toMatchObject({
			account: null,
			requestIds: [],
			knownCostUsd: "0.000000000",
			totalCostUsd: null,
		})
	})

	it("keeps the assignment of a request without a bill and leaves only its price unknown", () => {
		const explicit = { segment: { id: "input", attribution: "explicit", reason: "work-command" } }
		const report = calculatePullRequestCosts(
			[request("a", "work-a", "session-a", time(10), explicit), request("b", "work-b", "session-b"), commit()],
			[],
		)
		expect(report.requests.map((row) => [row.requestId, row.allocation, row.reason, row.priceStatus])).toEqual([
			["a", "pull-request", undefined, "missing"],
			["b", "unlinked", undefined, "missing"],
		])
		expect(report.pullRequests[0]).toMatchObject({ requestIds: ["a"], unknownRequestIds: [], totalCostUsd: null })
		expect(report.unallocated.unknown.requestIds).toEqual([])
	})
})

describe("scoped historical work corrections", () => {
	const source = "11111111-1111-4111-8111-111111111111"
	const target = "22222222-2222-4222-8222-222222222222"
	const requestId = "33333333-3333-4333-8333-333333333333"
	const scope = {
		account: { apiUrl: "https://api.example", organizationId: source, userId: target },
		repository: "/repo/.git",
	}
	const plan = () => request(requestId, source, "planning", time(10), { scope })
	const implementation = () => request("implementation", target, "implementing", time(11), { scope })
	const evidence = (overrides: Record<string, unknown> = {}): WorkRecord => ({
		version: 1,
		type: "work_link",
		workId: target,
		sessionId: "implementing",
		linkId: "44444444-4444-4444-8444-444444444444",
		revision: 1,
		sourceWorkId: source,
		targetWorkId: target,
		requestIds: [requestId],
		scope,
		status: "active",
		evidence: { source: "work-command" },
		...overrides,
	})
	const prices = () => [
		{ ...charge(requestId, "1"), account: scope.account },
		{ ...charge("implementation", "2"), account: scope.account },
	]
	it("joins only selected planning requests without changing original work IDs or counting twice", () => {
		const rows = [
			plan(),
			implementation(),
			request("unrelated", source, "planning", time(10), { scope }),
			commit(target),
			evidence(),
		]
		const original = structuredClone(rows)
		const costs = calculatePullRequestCosts([...rows, evidence()], prices())
		expect(costs.pullRequests[0].totalCostUsd).toBe("3.000000000")
		expect(costs.requests.find((row) => row.requestId === requestId)).toMatchObject({
			workIds: [source],
			linkedWorkIds: [target],
			allocation: "pull-request",
			totalCostUsd: "1.000000000",
		})
		expect(costs.requests.find((row) => row.requestId === "unrelated")).toMatchObject({
			allocation: "unlinked",
			pullRequestIds: [],
		})
		expect(rows).toEqual(original)
	})
	it("confirms an uncertain segment already in the right work and can revoke that confirmation", () => {
		const rows = [
			{ ...plan(), segment: { id: "planning-input", attribution: "unknown", reason: "unresolved-reference" } },
			commit(source),
		]
		const original = structuredClone(rows)
		const confirmed = evidence({ workId: source, targetWorkId: source })
		const costs = calculatePullRequestCosts([...rows, confirmed, confirmed], [prices()[0]])
		expect(costs.pullRequests[0].totalCostUsd).toBe("1.000000000")
		expect(costs.requests).toHaveLength(1)
		expect(costs.requests[0]).toMatchObject({
			workIds: [source],
			linkedWorkIds: [source],
			allocation: "pull-request",
		})
		const revoked = calculatePullRequestCosts(
			[...rows, confirmed, { ...confirmed, revision: 2, status: "revoked" }],
			[prices()[0]],
		)
		expect(revoked.pullRequests[0].totalCostUsd).toBeNull()
		expect(revoked.requests[0]).toMatchObject({ allocation: "unknown", totalCostUsd: "1.000000000" })
		expect(rows).toEqual(original)
	})
	it.each([
		"semantic",
		"missing-producer",
		"other-segment",
		"other-work",
	])("does not accept %s evidence as automatic artifact confirmation", (kind) => {
		const segmentId = "55555555-5555-4555-8555-555555555555"
		const confirmed = evidence({
			workId: source,
			targetWorkId: source,
			evidence: {
				source: kind === "semantic" ? "semantic" : "saved-plan",
				segmentId,
				requestId: kind === "missing-producer" ? target : requestId,
			},
		})
		if (kind === "other-work") {
			confirmed.workId = target
			confirmed.targetWorkId = target
		}
		const costs = calculatePullRequestCosts(
			[
				{
					...plan(),
					segment: {
						id: kind === "other-segment" ? target : segmentId,
						attribution: "unknown",
						reason: "unresolved-reference",
					},
				},
				implementation(),
				commit(source),
				commit(target),
				confirmed,
			],
			prices(),
		)
		expect(costs.requests.find((row) => row.requestId === requestId)).toMatchObject({
			allocation: "unknown",
			reason: "work-link-unresolved",
			totalCostUsd: "1.000000000",
		})
	})
	it.each([
		"revoked",
		"conflict",
		"other-account",
		"other-repository",
		"missing-scope",
	])("leaves a %s correction unresolved with its exact price intact", (kind) => {
		const edits = [evidence()]
		if (kind === "revoked") edits.push(evidence({ revision: 2, status: "revoked" }))
		if (kind === "conflict") edits.push(evidence({ status: "revoked" }))
		if (kind === "other-account")
			edits[0] = evidence({ scope: { ...scope, account: { ...scope.account, userId: requestId } } })
		if (kind === "other-repository") edits[0] = evidence({ scope: { ...scope, repository: "/other/.git" } })
		const planning = plan()
		if (kind === "missing-scope") planning.scope = undefined
		const costs = calculatePullRequestCosts([planning, implementation(), commit(target), ...edits], prices())
		expect(costs.requests.find((row) => row.requestId === requestId)).toMatchObject({
			allocation: "unknown",
			reason: kind === "missing-scope" ? "work-account-unverified" : "work-link-unresolved",
			totalCostUsd: "1.000000000",
		})
		expect(costs.pullRequests.find((row) => row.unknownRequestIds.includes(requestId))?.totalCostUsd).toBeNull()
	})
	it("applies a newer correction regardless of replay order", () => {
		const records = [
			plan(),
			implementation(),
			commit(target),
			evidence(),
			evidence({ revision: 2, status: "revoked" }),
			evidence({ revision: 3 }),
		]
		const costs = calculatePullRequestCosts(records, prices())
		expect(costs.pullRequests[0].totalCostUsd).toBe("3.000000000")
		expect(calculatePullRequestCosts([...records].reverse(), prices())).toEqual(costs)
	})
	it("does not treat an incomplete target PR lookup as a final corrected total", () => {
		const costs = calculatePullRequestCosts(
			[
				plan(),
				implementation(),
				commit(target),
				commit(target, [pullRequest()], "implementing", { pullRequests: [{}] }),
				evidence(),
			],
			prices(),
		)
		expect(costs.requests.find((row) => row.requestId === requestId)).toMatchObject({ allocation: "unknown" })
		expect(costs.pullRequests[0].totalCostUsd).toBeNull()
	})
})

describe("request matching decisions", () => {
	it("keeps an uncertain input out of its current work's confirmed PR total", () => {
		const report = calculatePullRequestCosts(
			[
				request("uncertain", "work-a", "session-a", time(10), {
					segment: { id: "segment-a", attribution: "unknown", reason: "model-uncertain" },
				}),
				commit(),
			],
			[charge("uncertain", "1.250000000")],
		)
		expect(report.requests[0]).toMatchObject({
			allocation: "unknown",
			reason: "work-match-unresolved",
			knownCostUsd: "1.250000000",
		})
		expect(report.pullRequests[0]).toMatchObject({
			requestIds: [],
			unknownRequestIds: ["uncertain"],
			knownCostUsd: "0.000000000",
			totalCostUsd: null,
		})
	})

	it("does not apply a later matching decision to an earlier request", () => {
		const report = calculatePullRequestCosts(
			[
				request("earlier", "work-a", "session-a", time(10), {
					segment: { id: "segment-a", attribution: "unknown", reason: "model-uncertain" },
				}),
				request("later", "work-a", "session-a", time(11), {
					segment: { id: "segment-b", attribution: "explicit", reason: "saved-plan" },
				}),
				commit(),
			],
			[charge("earlier", "1"), charge("later", "2")],
		)
		expect(report.pullRequests[0].requestIds).toEqual(["later"])
		expect(report.unallocated.unknown.requestIds).toEqual(["earlier"])
	})

	it("keeps every request on an open PR unmerged, whatever its matching evidence", () => {
		const open = pullRequest({ state: "open", mergeCommitSha: null, mergedAt: null, closedAt: null })
		const report = calculatePullRequestCosts(
			[
				request("confirmed", "work-a", "session-a", time(10), {
					segment: { id: "a", attribution: "explicit", reason: "work-command" },
				}),
				request("model", "work-a", "session-a", time(11), {
					segment: { id: "b", attribution: "inferred", reason: "model-same" },
				}),
				request("session", "work-a", "session-a", time(12), {
					segment: { id: "c", attribution: "session", reason: "matching-disabled" },
				}),
				commit("work-a", [open]),
			],
			[charge("confirmed", "1"), charge("model", "2"), charge("session", "4")],
		)
		expect(report.requests.map((row) => [row.requestId, row.allocation])).toEqual([
			["confirmed", "unmerged"],
			["model", "unmerged"],
			["session", "unmerged"],
		])
		expect(report.pullRequests[0]).toMatchObject({ knownCostUsd: "0.000000000", inferredRequestIds: [] })
		expect(report.unallocated.unmerged.totalCostUsd).toBe("7.000000000")
	})

	it("keeps inferred ownership visible next to an exact billed price", () => {
		const segment = { id: "segment-a", attribution: "inferred", reason: "model-same" }
		const scope = createWorkScopeSnapshot("/repo/.git").scope
		const report = calculatePullRequestCosts(
			[request("inferred", "work-a", "session-a", time(10), { segment, scope }), commit()],
			[{ ...charge("inferred", "1"), account: scope.account }],
		)
		expect(report.requests[0]).toMatchObject({ allocation: "inferred", segment, totalCostUsd: "1.000000000" })
		expect(report.pullRequests[0]).toMatchObject({
			requestIds: ["inferred"],
			inferredRequestIds: ["inferred"],
			knownCostUsd: "1.000000000",
			totalCostUsd: "1.000000000",
			explicit: { requestIds: [], totalCostUsd: "0.000000000" },
			inferred: { requestIds: ["inferred"], totalCostUsd: "1.000000000" },
		})
		expect(report.unallocated.inferred).toMatchObject({ requestIds: ["inferred"], totalCostUsd: "1.000000000" })
	})

	it.each([
		null,
		{},
		{ id: "segment-a", attribution: "guessed", reason: "invalid" },
	])("does not promote malformed segment evidence %j", (segment) => {
		const report = calculatePullRequestCosts(
			[request("bad", "work-a", "session-a", time(10), { segment }), commit()],
			[charge("bad", "1")],
		)
		expect(report.requests[0]).toMatchObject({ allocation: "unknown", reason: "work-match-unresolved" })
	})
})

function nativeEdit(requestId: string, fields: Record<string, unknown> = {}): WorkRecord {
	return {
		version: 1,
		type: "file_transition",
		workId: "work-a",
		sessionId: "session-a",
		requestId,
		transitionId: `edit-${requestId}`,
		toolCallId: `tool-${requestId}`,
		cwd: "/repo",
		repository: "/repo/.git",
		worktree: "/repo",
		path: `${requestId}.ts`,
		baseline: "c".repeat(40),
		baselineFile: { blob: "d".repeat(40), mode: "100644" },
		before: { blob: "d".repeat(40), mode: "100644" },
		after: { blob: "e".repeat(40), mode: "100644" },
		cursor: { bytes: 100, digest: "f".repeat(64) },
		...fields,
	}
}

function contribution(edit: WorkRecord, pull = pullRequest(), fields: Record<string, unknown> = {}): WorkRecord {
	return commit(edit.workId, [pull], edit.sessionId, {
		source: "native-file-transition",
		repository: edit.repository,
		worktree: edit.worktree,
		paths: [edit.path],
		transitionIds: [edit.transitionId],
		fileMatches: [
			{ path: edit.path, worktree: edit.worktree, method: "file-chain", transitionIds: [edit.transitionId] },
		],
		...fields,
	})
}

describe("exclusive native contributions within a multi-PR work", () => {
	const firstKey = "github:github.com/example/repository#1"
	const secondKey = "github:github.com/example/repository#2"
	const otherCommit = () => commit("work-a", [secondPull()], "session-a", { sha: "b".repeat(40) })
	it.each([
		"session",
		"inferred",
	])("allows complete evidence to strengthen an earlier hunk match (%s)", (attribution) => {
		const edit = nativeEdit("a")
		const weak = contribution(edit, pullRequest(), {
			fileMatches: [
				{ path: edit.path, worktree: edit.worktree, method: "file-hunks", transitionIds: [edit.transitionId] },
			],
		})
		const rows = [
			request("a", undefined, undefined, undefined, { segment: { id: "input-a", attribution, reason: "test" } }),
			edit,
			weak,
			otherCommit(),
		]
		const prices = [charge("a", "1")]
		expect(calculatePullRequestCosts(rows, prices).requests[0].allocation).toBe(
			attribution === "inferred" ? "inferred" : "shared",
		)
		rows.push(contribution(edit))
		const report = calculatePullRequestCosts(rows, prices)
		expect(report.requests[0]).toMatchObject({ allocation: "pull-request", pullRequestIds: [firstKey] })
		expect(report.pullRequests.find((row) => row.key === firstKey)?.totalCostUsd).toBe("1.000000000")
		expect(calculatePullRequestCosts(rows.toReversed(), prices)).toEqual(report)
	})

	it("allocates each editing request once while leaving planning and auxiliary requests shared", () => {
		const first = nativeEdit("first")
		const second = nativeEdit("second", { sessionId: "child" })
		const report = calculatePullRequestCosts(
			[
				request("first"),
				request("second", "work-a", "child"),
				request("plan"),
				request("title"),
				first,
				second,
				contribution(first),
				contribution(second, secondPull(), { sha: "b".repeat(40) }),
			],
			[charge("first", "0.1"), charge("second", "0.2"), charge("plan", "0.3"), charge("title", "0.01")],
		)
		expect(report.requests.find((row) => row.requestId === "first")).toMatchObject({
			allocation: "pull-request",
			pullRequestIds: [firstKey],
		})
		expect(report.requests.find((row) => row.requestId === "second")).toMatchObject({
			allocation: "pull-request",
			pullRequestIds: [secondKey],
			sessionIds: ["child"],
		})
		expect(report.pullRequests.map((row) => [row.requestIds, row.knownCostUsd, row.totalCostUsd])).toEqual([
			[["first"], "0.100000000", null],
			[["second"], "0.200000000", null],
		])
		expect(report.unallocated.shared).toMatchObject({ requestIds: ["plan", "title"], totalCostUsd: "0.310000000" })
	})

	it("joins separate PR observations and all native transitions without replaying charges twice", () => {
		const first = nativeEdit("a")
		const second = nativeEdit("a", { transitionId: "edit-other", path: "other.ts", toolCallId: "tool-other" })
		const records = [
			request("a"),
			first,
			second,
			contribution(first, pullRequest(), { pullRequests: undefined }),
			contribution(second, pullRequest(), { pullRequests: undefined }),
			commit(),
			otherCommit(),
		]
		const prices = [charge("a", "0.1", "one"), charge("a", "0.000000001", "two")]
		const report = calculatePullRequestCosts(records, prices)
		expect(report.pullRequests[0]).toMatchObject({ requestIds: ["a"], totalCostUsd: "0.100000001" })
		expect(report.pullRequests[1]).toMatchObject({ requestIds: [], knownCostUsd: "0.000000000" })
		expect(calculatePullRequestCosts([...records, ...records].reverse(), [...prices, ...prices].reverse())).toEqual(
			report,
		)
	})

	it("keeps a whole request shared when its native edits contribute to different PRs", () => {
		const first = nativeEdit("a")
		const second = nativeEdit("a", { transitionId: "edit-other", path: "other.ts" })
		const report = calculatePullRequestCosts(
			[request("a"), first, second, contribution(first), contribution(second, secondPull(), { sha: "b".repeat(40) })],
			[charge("a", "1")],
		)
		expect(report.unallocated.shared.totalCostUsd).toBe("1.000000000")
		expect(report.pullRequests.every((row) => row.knownCostUsd === "0.000000000" && row.totalCostUsd === null)).toBe(
			true,
		)
	})

	it.each(["unlinked", "weak"])("requires every native transition a commit names to be covered (%s)", (kind) => {
		const first = nativeEdit("a")
		const second = nativeEdit("a", { transitionId: "edit-other", path: "other.ts" })
		const records = [
			request("a"),
			first,
			second,
			contribution(first),
			otherCommit(),
			contribution(second, pullRequest(), {
				sha: "f".repeat(40),
				...(kind === "unlinked"
					? { pullRequests: [] }
					: {
							fileMatches: [
								{
									path: second.path,
									worktree: second.worktree,
									method: "path-blob",
									transitionIds: [second.transitionId],
								},
							],
						}),
			}),
		]
		expect(calculatePullRequestCosts(records, [charge("a", "1")]).requests[0].allocation).toBe("shared")
	})

	it("does not let a native edit no commit names, such as a scratch file, block the PR its other edits prove", () => {
		const first = nativeEdit("a")
		const scratch = nativeEdit("a", { transitionId: "edit-scratch", path: "notes.md" })
		const records = [request("a"), first, scratch, contribution(first), otherCommit()]
		expect(calculatePullRequestCosts(records, [charge("a", "1")]).requests[0]).toMatchObject({
			allocation: "pull-request",
			pullRequestIds: [firstKey],
		})
	})

	it.each([
		"workId",
		"sessionId",
		"repository",
		"worktree",
		"path",
		"requestId",
		"after",
	])("rejects conflicting transition definitions (%s)", (field) => {
		const edit = nativeEdit("a")
		const conflicting = { ...edit, [field]: field === "after" ? { blob: "f".repeat(40), mode: "100644" } : "different" }
		const records = [request("a"), edit, conflicting, contribution(edit), otherCommit()]
		const report = calculatePullRequestCosts(records, [charge("a", "1")])
		expect(report.requests[0].allocation).toBe("shared")
		expect(calculatePullRequestCosts(records.toReversed(), [charge("a", "1")])).toEqual(report)
	})

	it.each(["workId", "sessionId", "repository", "worktree"])("rejects a contribution with the wrong %s", (field) => {
		const edit = nativeEdit("a")
		const forged = contribution(edit, pullRequest(), { [field]: "different" })
		const report = calculatePullRequestCosts([request("a"), edit, forged, commit(), otherCommit()], [charge("a", "1")])
		expect(report.requests[0].allocation).toBe("shared")
	})

	it.each([
		undefined,
		"",
		"missing",
		"malformed",
	])("does not treat missing or invalid transition identity as coverage (%s)", (transitionId) => {
		const edit = nativeEdit("a", { transitionId })
		const rows = transitionId === "missing" ? [] : [edit]
		if (transitionId === "malformed") edit.after = { blob: "not-a-blob", mode: "100644" }
		const report = calculatePullRequestCosts(
			[request("a"), ...rows, contribution(edit), otherCommit()],
			[charge("a", "1")],
		)
		expect(report.requests[0].allocation).toBe("shared")
	})

	it("requires the native file match rather than broad commit transition IDs", () => {
		const edit = nativeEdit("a")
		const record = contribution(edit, pullRequest(), {
			fileMatches: [
				{ path: edit.path, worktree: edit.worktree, method: "path-blob", transitionIds: [edit.transitionId] },
			],
		})
		expect(
			calculatePullRequestCosts([request("a"), edit, record, otherCommit()], [charge("a", "1")]).requests[0].allocation,
		).toBe("shared")
	})

	it("does not claim complete coverage when one file match references a missing transition", () => {
		const edit = nativeEdit("a")
		const record = contribution(edit, pullRequest(), {
			fileMatches: [
				{
					path: edit.path,
					worktree: edit.worktree,
					method: "file-chain",
					transitionIds: [edit.transitionId, "missing"],
				},
			],
		})
		expect(
			calculatePullRequestCosts([request("a"), edit, record, otherCommit()], [charge("a", "1")]).requests[0].allocation,
		).toBe("shared")
	})

	it.each([
		{ fileMatches: [] },
		{ fileMatches: [{ transitionIds: [null] }] },
		{ fileMatches: [{ transitionIds: ["missing"] }] },
	])("does not ignore unreadable native file evidence (%j)", ({ fileMatches }) => {
		const edit = nativeEdit("a")
		const broken = contribution(edit, secondPull(), { sha: "b".repeat(40), fileMatches })
		expect(
			calculatePullRequestCosts([request("a"), edit, contribution(edit), broken], [charge("a", "1")]).requests[0]
				.allocation,
		).toBe("shared")
	})

	it("does not validate a chain whose other recorded member is malformed", () => {
		const edit = nativeEdit("a")
		const broken = nativeEdit("b", { path: edit.path, before: { blob: "broken", mode: "100644" } })
		const record = contribution(edit, pullRequest(), {
			fileMatches: [
				{
					path: edit.path,
					worktree: edit.worktree,
					method: "file-chain",
					transitionIds: [edit.transitionId, broken.transitionId],
				},
			],
		})
		expect(
			calculatePullRequestCosts(
				[request("a"), request("b"), edit, broken, record, otherCommit()],
				[charge("a", "1"), charge("b", "1")],
			).requests.every((row) => row.allocation === "shared"),
		).toBe(true)
	})

	it("keeps a tracked rewrite without its own native file proof shared", () => {
		const edit = nativeEdit("a")
		const copy = otherCommit()
		copy.rewrittenFrom = "a".repeat(40)
		expect(
			calculatePullRequestCosts([request("a"), edit, contribution(edit), copy], [charge("a", "1")]).requests[0]
				.allocation,
		).toBe("shared")
	})

	it("keeps the original request owner even when all native evidence claims another owner", () => {
		const edit = nativeEdit("a", { workId: "work-other", sessionId: "session-other" })
		const report = calculatePullRequestCosts(
			[request("a"), edit, contribution(edit), commit(), otherCommit()],
			[charge("a", "1")],
		)
		expect(report.requests[0]).toMatchObject({ allocation: "shared", workIds: ["work-a"], sessionIds: ["session-a"] })
	})

	it("supports a native new file in a root commit without inventing an earlier blob", () => {
		const edit = nativeEdit("a", { baseline: null, baselineFile: null, before: null })
		expect(
			calculatePullRequestCosts([request("a"), edit, contribution(edit), otherCommit()], [charge("a", "1")])
				.requests[0],
		).toMatchObject({ allocation: "pull-request", pullRequestIds: [firstKey] })
	})

	it.each([
		"shared-copy",
		"unlinked-copy",
	])("does not assume a rewritten copy has the original exclusive PR (%s)", (kind) => {
		const edit = nativeEdit("a")
		const copied = contribution(edit, secondPull(), {
			sha: "f".repeat(40),
			rewrittenFrom: "a".repeat(40),
			...(kind === "unlinked-copy" ? { pullRequests: [] } : {}),
		})
		expect(
			calculatePullRequestCosts([request("a"), edit, contribution(edit), copied, otherCommit()], [charge("a", "1")])
				.requests[0].allocation,
		).toBe("shared")
	})

	it.each(["boundary", "after", "open"])("uses only the proven target's merge cutoff (%s)", (kind) => {
		const edit = nativeEdit("a")
		const target = kind === "open" ? pullRequest({ state: "open", mergedAt: null }) : pullRequest()
		const report = calculatePullRequestCosts(
			[
				request("a", undefined, undefined, time(kind === "after" ? 31 : 30)),
				edit,
				contribution(edit, target),
				commit("work-a", [{ ...secondPull(), mergedAt: time(50), checkedAt: time(55) }], "session-a", {
					sha: "b".repeat(40),
				}),
			],
			[charge("a", "1")],
		)
		expect(report.requests[0]).toMatchObject({
			pullRequestIds: [firstKey],
			allocation: kind === "after" ? "post-merge" : kind === "open" ? "unmerged" : "pull-request",
		})
		expect(report.pullRequests[1].requestIds).toEqual([])
	})

	it("keeps absent and incomplete prices unknown and updates late exact prices on the proven PR", () => {
		const edit = nativeEdit("a")
		const records = [request("a"), edit, contribution(edit), otherCommit()]
		expect(calculatePullRequestCosts(records, []).pullRequests[0].totalCostUsd).toBeNull()
		expect(calculatePullRequestCosts(records, [charge("a", "0")]).pullRequests[0].totalCostUsd).toBe("0.000000000")
		expect(
			calculatePullRequestCosts(records, [charge("a", "0.123456789")], new Set(["a"])).pullRequests[0],
		).toMatchObject({ knownCostUsd: "0.123456789", totalCostUsd: null })
		expect(calculatePullRequestCosts(records, [charge("a", "0.123456789")]).pullRequests[0].totalCostUsd).toBe(
			"0.123456789",
		)
	})
})

describe("confirmed and inferred spend per input", () => {
	it("confirms the input that produced native edits and keeps other session inputs inferred", () => {
		const segment = { id: "implementation", attribution: "session", reason: "matching-disabled" }
		const edit = nativeEdit("edit")
		const rows = [
			request("prepare", "work-a", "session-a", time(8), { segment }),
			request("edit", "work-a", "session-a", time(10), { segment }),
			request("chat", "work-a", "session-a", time(11), { segment: { ...segment, id: "side-question" } }),
			edit,
			contribution(edit),
		]
		const costs = calculatePullRequestCosts(rows, [
			charge("prepare", "0.1"),
			charge("edit", "0.2"),
			charge("chat", "0.000000001"),
		])
		expect(costs.requests.map((row) => [row.requestId, row.allocation])).toEqual([
			["chat", "inferred"],
			["edit", "pull-request"],
			["prepare", "pull-request"],
		])
		expect(costs.pullRequests[0]).toMatchObject({
			requestIds: ["chat", "edit", "prepare"],
			totalCostUsd: "0.300000001",
			explicit: { requestIds: ["edit", "prepare"], totalCostUsd: "0.300000000" },
			inferred: { requestIds: ["chat"], totalCostUsd: "0.000000001" },
		})
	})
	it("keeps an input shared when its requests edited two different PRs", () => {
		const segment = { id: "one-input", attribution: "session", reason: "matching-disabled" }
		const first = nativeEdit("first")
		const second = nativeEdit("second", { path: "second.ts" })
		const costs = calculatePullRequestCosts(
			[
				request("first", "work-a", "session-a", time(10), { segment }),
				request("second", "work-a", "session-a", time(11), { segment }),
				first,
				second,
				contribution(first),
				contribution(second, secondPull(), { sha: "b".repeat(40) }),
			],
			[charge("first", "1"), charge("second", "2")],
		)
		expect(costs.requests.map((row) => row.allocation)).toEqual(["shared", "shared"])
		expect(costs.pullRequests.every((row) => row.totalCostUsd === null)).toBe(true)
	})
})

describe("calculatePullRequestCosts", () => {
	it("keeps a known subtotal when the billing lookup has not returned every page", () => {
		const report = calculatePullRequestCosts([request("a"), commit()], [charge("a", "1.25")], new Set(["a"]))
		expect(report.requests[0]).toMatchObject({
			priceStatus: "missing",
			knownCostUsd: "1.250000000",
			totalCostUsd: null,
		})
		expect(report.pullRequests[0]).toMatchObject({ knownCostUsd: "1.250000000", totalCostUsd: null })
	})
	it.each(["regular", "squash"])("includes planning, child agents and fixes through a %s merge", (merge) => {
		const records = [
			request("plan", "work-a", "planning"),
			request("implementation", "work-a", "implementation", time(20)),
			request("child", "work-a", "child", time(25)),
			request("fix", "work-a", "implementation", time(30)),
			commit("work-a", [pullRequest({ mergeCommitSha: (merge === "squash" ? "c" : "b").repeat(40) })]),
		]
		const report = calculatePullRequestCosts(records, [
			charge("plan", "0.1"),
			charge("implementation", "0.2"),
			charge("child", "0.000000001"),
			charge("fix", "0.000000009"),
		])

		expect(report.pullRequests).toHaveLength(1)
		expect(report.pullRequests[0]).toMatchObject({
			requestIds: ["child", "fix", "implementation", "plan"],
			workIds: ["work-a"],
			knownCostUsd: "0.300000010",
			totalCostUsd: "0.300000010",
			sharedRequestIds: [],
			unknownRequestIds: [],
		})
		// Without input records or native edits, nothing confirms the requests: they count as inferred.
		expect(report.requests.every((row) => row.allocation === "inferred")).toBe(true)
	})

	it("infers a request without an input record and keeps an explicitly selected input confirmed", () => {
		const explicit = { segment: { id: "input", attribution: "explicit", reason: "work-command" } }
		const report = calculatePullRequestCosts(
			[request("a"), request("b", "work-a", "session-a", time(11), explicit), commit()],
			[charge("a", "1"), charge("b", "2")],
		)
		expect(report.requests.map((row) => [row.requestId, row.allocation])).toEqual([
			["a", "inferred"],
			["b", "pull-request"],
		])
	})

	it.each(["session-a", "session-b"])("includes two works for one PR across %s", (session) => {
		const report = calculatePullRequestCosts(
			[request("a"), request("b", "work-b", session), commit(), commit("work-b", undefined, session)],
			[charge("a", "1"), charge("b", "2")],
		)
		expect(report.pullRequests[0]).toMatchObject({
			requestIds: ["a", "b"],
			workIds: ["work-a", "work-b"],
			totalCostUsd: "3.000000000",
		})
	})

	it("counts retries once each and is unchanged by ledger replay, billing replay or input order", () => {
		const records = [request("retry-1"), request("retry-2"), commit(), commit()]
		const observations = [charge("retry-1", "0.01"), charge("retry-2", "0.02")]
		const report = calculatePullRequestCosts(records, observations)
		expect(report.pullRequests[0].totalCostUsd).toBe("0.030000000")
		expect(
			calculatePullRequestCosts([...records, ...records].reverse(), [...observations, ...observations].reverse()),
		).toEqual(report)
	})

	it("sums distinct authoritative billing rows without charging repeated rows again", () => {
		const report = calculatePullRequestCosts(
			[request("a"), commit()],
			[charge("a", "0.1", "attempt-1"), charge("a", "0.2", "attempt-2"), charge("a", "0.10", "attempt-1")],
		)
		expect(report.requests[0]).toMatchObject({
			billingRecordIds: ["attempt-1", "attempt-2"],
			priceStatus: "priced",
			totalCostUsd: "0.300000000",
		})
	})

	it("keeps a work spanning PRs in shared cost instead of multiplying it", () => {
		const report = calculatePullRequestCosts(
			[request("a"), commit("work-a", [pullRequest(), secondPull()])],
			[charge("a", "0.4")],
		)
		expect(report.unallocated.shared).toEqual({
			requestIds: ["a"],
			knownCostUsd: "0.400000000",
			totalCostUsd: "0.400000000",
		})
		expect(report.pullRequests).toHaveLength(2)
		for (const pull of report.pullRequests) {
			expect(pull).toMatchObject({
				requestIds: [],
				sharedRequestIds: ["a"],
				knownCostUsd: "0.000000000",
				totalCostUsd: null,
			})
		}
	})

	it("keeps a work linked to both a merged and an open PR shared", () => {
		const report = calculatePullRequestCosts(
			[request("a"), commit("work-a", [pullRequest(), { ...secondPull(), state: "open", mergedAt: null }])],
			[charge("a", "1")],
		)
		expect(report.unallocated.shared.totalCostUsd).toBe("1.000000000")
		expect(report.pullRequests.every((row) => row.totalCostUsd === null && row.knownCostUsd === "0.000000000")).toBe(
			true,
		)
	})

	it("allocates separate works in one session without assigning its unrelated work", () => {
		const report = calculatePullRequestCosts(
			[
				request("a"),
				request("b", "work-b"),
				request("unrelated", "work-c"),
				commit(),
				commit("work-b", [secondPull()]),
			],
			[charge("a", "1"), charge("b", "2"), charge("unrelated", "4")],
		)
		expect(report.unallocated.shared.requestIds).toEqual([])
		expect(report.unallocated.unlinked).toMatchObject({ requestIds: ["unrelated"], totalCostUsd: "4.000000000" })
		expect(report.requests.find((row) => row.requestId === "unrelated")?.pullRequestIds).toEqual([])
		expect(report.pullRequests.map((row) => [row.requestIds, row.totalCostUsd])).toEqual([
			[["a"], "1.000000000"],
			[["b"], "2.000000000"],
		])
	})

	it("keeps only the multi-PR work shared when another work in the same session has one PR", () => {
		const report = calculatePullRequestCosts(
			[
				request("shared"),
				request("exclusive", "work-b"),
				commit("work-a", [pullRequest(), secondPull()]),
				commit("work-b", [secondPull()]),
			],
			[charge("shared", "1"), charge("exclusive", "2")],
		)
		expect(report.unallocated.shared.requestIds).toEqual(["shared"])
		expect(report.requests.find((row) => row.requestId === "exclusive")?.allocation).toBe("inferred")
		expect(report.pullRequests[1]).toMatchObject({
			requestIds: ["exclusive"],
			sharedRequestIds: ["shared"],
			knownCostUsd: "2.000000000",
			totalCostUsd: null,
		})
	})

	it("does not make separate sessions for separate PRs shared", () => {
		const report = calculatePullRequestCosts(
			[request("a"), request("b", "work-b", "session-b"), commit(), commit("work-b", [secondPull()], "session-b")],
			[charge("a", "1"), charge("b", "2")],
		)
		expect(report.pullRequests.map((row) => row.totalCostUsd)).toEqual(["1.000000000", "2.000000000"])
	})

	it("keeps requests after merge separate and includes requests at the merge boundary", () => {
		const report = calculatePullRequestCosts(
			[
				request("before"),
				request("boundary", undefined, undefined, time(30)),
				request("later", undefined, undefined, time(31)),
				commit(),
			],
			[charge("before", "1"), charge("boundary", "2"), charge("later", "4")],
		)
		expect(report.pullRequests[0]).toMatchObject({ requestIds: ["before", "boundary"], totalCostUsd: "3.000000000" })
		expect(report.unallocated["post-merge"]).toMatchObject({ requestIds: ["later"], totalCostUsd: "4.000000000" })
	})

	it("keeps requests after every linked merge separate even when the work spans PRs", () => {
		const report = calculatePullRequestCosts(
			[request("later", undefined, undefined, time(31)), commit("work-a", [pullRequest(), secondPull()])],
			[charge("later", "1")],
		)
		expect(report.unallocated["post-merge"].requestIds).toEqual(["later"])
		expect(report.unallocated.shared.requestIds).toEqual([])
	})

	it("uses the first request time rather than a later enrichment observation", () => {
		const records = [
			request("a", undefined, undefined, time(5)),
			request("a", undefined, undefined, time(50)),
			commit(),
		]
		const report = calculatePullRequestCosts(records, [charge("a", "1")])
		expect(report.requests[0].startedAt).toBe(time(5))
		expect(report.pullRequests[0].totalCostUsd).toBe("1.000000000")
		expect(calculatePullRequestCosts(records.toReversed(), [charge("a", "1")])).toEqual(report)
	})

	it("uses explicit original startedAt when the available observation was saved after merge", () => {
		const report = calculatePullRequestCosts(
			[request("a", undefined, undefined, time(50), { startedAt: time(5) }), commit()],
			[charge("a", "1")],
		)
		expect(report.requests[0].startedAt).toBe(time(5))
		expect(report.pullRequests[0].totalCostUsd).toBe("1.000000000")
	})

	it("uses the attempt record when response metadata arrives under a later session context", () => {
		const response: WorkRecord = {
			version: 1,
			type: "request_response",
			requestId: "a",
			workId: "work-later",
			sessionId: "session-later",
			recordedAt: time(50),
		}
		const report = calculatePullRequestCosts([request("a"), response, commit()], [charge("a", "1")])
		expect(report.requests[0]).toMatchObject({
			workIds: ["work-a"],
			sessionIds: ["session-a"],
			startedAt: time(10),
			allocation: "inferred",
		})
	})

	it("updates the original merged PR when an earlier request gets its price later", () => {
		const records = [request("a"), request("b"), commit()]
		const partial = calculatePullRequestCosts(records, [charge("a", "0.1"), charge("b", null)])
		expect(partial.pullRequests[0]).toMatchObject({ knownCostUsd: "0.100000000", totalCostUsd: null })
		expect(partial.requests.find((row) => row.requestId === "b")?.priceStatus).toBe("missing")
		const priced = calculatePullRequestCosts(records, [charge("a", "0.1"), charge("b", null), charge("b", "0.2")])
		expect(priced.pullRequests[0].totalCostUsd).toBe("0.300000000")
	})

	it("retains known billing rows when another row for that request has no price", () => {
		const report = calculatePullRequestCosts(
			[request("a"), commit()],
			[charge("a", "0.1", "priced"), charge("a", null, "waiting")],
		)
		expect(report.requests[0]).toMatchObject({
			priceStatus: "missing",
			knownCostUsd: "0.100000000",
			totalCostUsd: null,
		})
		expect(report.pullRequests[0]).toMatchObject({ knownCostUsd: "0.100000000", totalCostUsd: null })
	})

	it("distinguishes an absent price from an explicitly priced zero", () => {
		const records = [request("a"), commit()]
		expect(calculatePullRequestCosts(records, []).pullRequests[0]).toMatchObject({
			knownCostUsd: "0.000000000",
			totalCostUsd: null,
		})
		expect(calculatePullRequestCosts(records, [charge("a", "0")]).pullRequests[0].totalCostUsd).toBe("0.000000000")
	})

	it.each(["open", "closed"] as const)("keeps %s PR costs outside merged totals", (state) => {
		const report = calculatePullRequestCosts(
			[request("a"), commit("work-a", [pullRequest({ state, mergedAt: null })])],
			[charge("a", "1")],
		)
		expect(report.unallocated.unmerged).toMatchObject({ requestIds: ["a"], totalCostUsd: "1.000000000" })
		expect(report.pullRequests[0].totalCostUsd).toBeNull()
	})

	it("uses the latest valid provider observation and retains legacy GitHub links", () => {
		const latest = pullRequest({ provider: undefined })
		const records = [
			request("a"),
			commit("work-a", [latest]),
			commit("work-a", [pullRequest({ state: "open", mergedAt: null, checkedAt: time(25) })]),
			commit("work-a", [pullRequest({ state: "open", mergedAt: null, checkedAt: "broken" })]),
		]
		const report = calculatePullRequestCosts(records, [charge("a", "1")])
		expect(report.pullRequests).toHaveLength(1)
		expect(report.pullRequests[0]).toMatchObject({
			pullRequest: { provider: "github", state: "merged" },
			totalCostUsd: "1.000000000",
		})
	})

	it("does not allocate the full work to one valid PR when another identity lacks valid provider metadata", () => {
		const records = [request("a"), commit("work-a", [pullRequest(), { ...secondPull(), checkedAt: "broken" }])]
		const report = calculatePullRequestCosts(records, [charge("a", "1")])
		expect(report.unallocated.unknown.requestIds).toEqual(["a"])
		expect(report.pullRequests).toHaveLength(2)
		expect(report.pullRequests.every((row) => row.totalCostUsd === null && row.knownCostUsd === "0.000000000")).toBe(
			true,
		)
		expect(report.pullRequests[1].pullRequest).toBeNull()
		const recovered = calculatePullRequestCosts([...records, commit("work-a", [secondPull()])], [charge("a", "1")])
		expect(recovered.unallocated.shared.requestIds).toEqual(["a"])
	})

	it.each([
		null,
		{},
		{ ...secondPull(), url: "https://other.example/example/repository/pull/2" },
	])("keeps unreadable link %j from making another PR's total look complete", (invalidLink) => {
		const report = calculatePullRequestCosts(
			[request("a"), commit(undefined, undefined, undefined, { pullRequests: [pullRequest(), invalidLink] })],
			[charge("a", "1")],
		)
		expect(report.requests[0]).toMatchObject({ allocation: "unknown", reason: "pull-request-invalid" })
		expect(report.pullRequests[0]).toMatchObject({
			unknownRequestIds: ["a"],
			knownCostUsd: "0.000000000",
			totalCostUsd: null,
		})
	})

	it("does not call a malformed link collection unlinked work", () => {
		const report = calculatePullRequestCosts(
			[request("a"), commit(undefined, undefined, undefined, { pullRequests: "broken" })],
			[charge("a", "1")],
		)
		expect(report.unallocated.unknown.requestIds).toEqual(["a"])
		expect(report.unallocated.unlinked.requestIds).toEqual([])
	})

	it("keeps an unreadable link confined to its work within a shared session", () => {
		const report = calculatePullRequestCosts(
			[
				request("a"),
				request("b", "work-b"),
				commit(),
				commit("work-b", undefined, undefined, { pullRequests: [null] }),
			],
			[charge("a", "1"), charge("b", "2")],
		)
		expect(report.requests[0]).toMatchObject({ requestId: "a", allocation: "inferred" })
		expect(report.requests[1]).toMatchObject({ requestId: "b", allocation: "unknown", reason: "pull-request-invalid" })
		expect(report.pullRequests[0].totalCostUsd).toBe("1.000000000")
	})

	it("uses provider, host, repository and number as the PR identity", () => {
		const pulls = [
			pullRequest(),
			pullRequest({ host: "git.example.com", url: "https://git.example.com/example/repository/pull/1" }),
			pullRequest({ repository: "example/other", url: "https://github.com/example/other/pull/1" }),
			pullRequest({ provider: "gitlab", url: "https://github.com/example/repository/-/merge_requests/1" }),
		]
		const report = calculatePullRequestCosts([request("a"), commit("work-a", pulls)], [charge("a", "1")])
		expect(report.pullRequests).toHaveLength(4)
		expect(new Set(report.pullRequests.map((row) => row.key)).size).toBe(4)
		expect(report.unallocated.shared.totalCostUsd).toBe("1.000000000")
	})

	it("does not duplicate a GitHub identity when host or repository capitalization differs", () => {
		const report = calculatePullRequestCosts(
			[
				request("a"),
				commit("work-a", [
					pullRequest(),
					pullRequest({
						host: "GITHUB.COM",
						repository: "Example/Repository",
						url: "https://github.com/Example/Repository/pull/1",
					}),
				]),
			],
			[charge("a", "1")],
		)
		expect(report.pullRequests).toHaveLength(1)
		expect(report.pullRequests[0].totalCostUsd).toBe("1.000000000")
	})

	it("does not choose between contradictory provider observations at the same time", () => {
		const records = [request("a"), commit(), commit("work-a", [pullRequest({ state: "open", mergedAt: null })])]
		const report = calculatePullRequestCosts(records, [charge("a", "1")])
		expect(report.unallocated.unknown.requestIds).toEqual(["a"])
		expect(report.pullRequests[0]).toMatchObject({ pullRequest: null, unknownRequestIds: ["a"], totalCostUsd: null })
		expect(calculatePullRequestCosts(records.toReversed(), [charge("a", "1")])).toEqual(report)
		const corrected = calculatePullRequestCosts(
			[...records, commit("work-a", [pullRequest({ checkedAt: time(50) })])],
			[charge("a", "1")],
		)
		expect(corrected.pullRequests[0].totalCostUsd).toBe("1.000000000")
	})

	it("does not charge a request to one of several conflicting owners", () => {
		const report = calculatePullRequestCosts(
			[request("a"), request("a", "work-b", "session-b"), commit(), commit("work-b", [secondPull()], "session-b")],
			[charge("a", "1")],
		)
		expect(report.requests[0]).toMatchObject({
			allocation: "unknown",
			reason: "request-owner-conflict",
			workIds: ["work-a", "work-b"],
			sessionIds: ["session-a", "session-b"],
		})
		expect(report.unallocated.unknown.totalCostUsd).toBe("1.000000000")
		expect(report.pullRequests.every((row) => row.totalCostUsd === null)).toBe(true)
	})

	it("keeps a linked request with an unknown start time out of the merge total", () => {
		const report = calculatePullRequestCosts(
			[request("a", undefined, undefined, "broken"), commit()],
			[charge("a", "1")],
		)
		expect(report.requests[0]).toMatchObject({ allocation: "unknown", reason: "request-time-missing", startedAt: null })
		expect(report.pullRequests[0].totalCostUsd).toBeNull()
	})

	it.each([
		"1",
		"2026-02-30T10:00:00Z",
		"2025-02-29T10:00:00Z",
		"2026-10-02T10:00:00",
		"2026-00-01T10:00:00Z",
		"2026-13-01T10:00:00Z",
		"2026-01-00T10:00:00Z",
		"2026-01-32T10:00:00Z",
	])("rejects an ambiguous or invalid request timestamp %j", (recordedAt) => {
		const report = calculatePullRequestCosts(
			[request("a", undefined, undefined, recordedAt), commit()],
			[charge("a", "1")],
		)
		expect(report.requests[0]).toMatchObject({ allocation: "unknown", reason: "request-time-missing", startedAt: null })
		expect(report.pullRequests[0].totalCostUsd).toBeNull()
	})

	it("compares merge boundaries in UTC when source timestamps have an offset", () => {
		const report = calculatePullRequestCosts(
			[request("a", undefined, undefined, "2026-10-02T12:30:00+02:00"), commit()],
			[charge("a", "1")],
		)
		expect(report.pullRequests[0].totalCostUsd).toBe("1.000000000")
	})

	it("does not choose between contradictory prices for the same billing row", () => {
		const observations = [charge("a", "1"), charge("a", "2")]
		const report = calculatePullRequestCosts([request("a"), commit()], observations)
		expect(report.requests[0]).toMatchObject({
			priceStatus: "conflict",
			knownCostUsd: "0.000000000",
			totalCostUsd: null,
		})
		expect(report.pullRequests[0].totalCostUsd).toBeNull()
		expect(calculatePullRequestCosts([request("a"), commit()], observations.toReversed())).toEqual(report)
	})

	it("never assigns one billing row to two requests, including a request missing from the local ledger", () => {
		const report = calculatePullRequestCosts(
			[request("a"), commit()],
			[charge("a", "1", "billing-1"), charge("outside", "1", "billing-1")],
		)
		expect(report.requests[0]).toMatchObject({
			priceStatus: "conflict",
			knownCostUsd: "0.000000000",
			totalCostUsd: null,
		})
	})

	it.each(["", " billing-id", "billing-id "])("rejects an invalid billing identity %j", (billingId) => {
		const report = calculatePullRequestCosts([request("a"), commit()], [charge("a", "1", billingId)])
		expect(report.requests[0]).toMatchObject({
			priceStatus: "invalid",
			knownCostUsd: "0.000000000",
			totalCostUsd: null,
		})
	})

	it.each([
		"-1",
		"1e-9",
		"NaN",
		"Infinity",
		" 1",
		"1 ",
		"0.0000000001",
		"1000000000",
		"",
		"1.",
	])("rejects invalid Decimal(18,9) amount %j without treating it as free", (amount) => {
		const report = calculatePullRequestCosts([request("a"), commit()], [charge("a", amount)])
		expect(report.requests[0]).toMatchObject({
			priceStatus: "invalid",
			knownCostUsd: "0.000000000",
			totalCostUsd: null,
		})
		expect(report.pullRequests[0].totalCostUsd).toBeNull()
	})

	it("sums maximum decimal values and nanodollars without floating-point rounding or aggregate overflow", () => {
		const report = calculatePullRequestCosts(
			[request("a"), request("b"), request("c"), commit()],
			[charge("a", "999999999.999999999"), charge("b", "999999999.999999999"), charge("c", "0.000000001")],
		)
		expect(report.pullRequests[0].totalCostUsd).toBe("1999999999.999999999")
	})
})

describe("repository renames", () => {
	it("prices a PR once when links from before and after a rename share its provider ID", () => {
		const beforeRename = pullRequest({
			id: "81",
			repositoryId: "42",
			state: "open",
			mergeCommitSha: null,
			mergedAt: null,
			closedAt: null,
			checkedAt: time(25),
		})
		const afterRename = pullRequest({
			id: "81",
			repositoryId: "42",
			repository: "example/renamed",
			url: "https://github.com/example/renamed/pull/1",
			checkedAt: time(45),
		})
		const report = calculatePullRequestCosts(
			[request("a"), commit("work-a", [beforeRename, afterRename])],
			[charge("a", "1")],
		)
		expect(report.pullRequests).toHaveLength(1)
		expect(report.requests[0]).toMatchObject({ allocation: "inferred", totalCostUsd: "1.000000000" })
		expect(report.pullRequests[0]).toMatchObject({ requestIds: ["a"], totalCostUsd: "1.000000000" })
	})
})

describe("requests started after a PR merged", () => {
	it.each([
		["has no bill yet", [] as RequestCostObservation[], {}],
		[
			"has an unresolved work match",
			[charge("late", "2")],
			{ segment: { id: "later-input", attribution: "unknown", reason: "model-uncertain" } },
		],
		[
			"was billed to another account",
			[{ ...charge("late", "2"), account: { ...testScope.account, userId: "50000000-0000-4000-8000-000000000005" } }],
			{},
		],
	])("keeps the merged PR total complete when a later request %s", (_case, lateCharges, fields) => {
		const report = calculatePullRequestCosts(
			[request("before"), request("late", "work-a", "session-a", time(35), fields), commit()],
			[charge("before", "1"), ...lateCharges],
		)
		expect(report.pullRequests[0]).toMatchObject({
			requestIds: ["before"],
			unknownRequestIds: [],
			totalCostUsd: "1.000000000",
		})
	})
})

describe("one work across a merged PR and its follow-up", () => {
	it.each([
		["is still open", { state: "open" as const, mergedAt: null, closedAt: null }],
		["merged later", { mergedAt: time(50), closedAt: time(50) }],
	])("keeps the merged PR complete when the follow-up %s", (_case, followUp) => {
		const edit = nativeEdit("first")
		const report = calculatePullRequestCosts(
			[
				request("first"),
				edit,
				contribution(edit),
				request("follow-up", "work-a", "session-a", time(35)),
				commit("work-a", [{ ...secondPull(), ...followUp }], "session-a", { sha: "c".repeat(40) }),
			],
			[charge("first", "1"), charge("follow-up", "2")],
		)
		const [first, second] = [1, 2].map((number) =>
			report.pullRequests.find((row) => row.pullRequest?.number === number),
		)
		expect(first).toMatchObject({ sharedRequestIds: [], totalCostUsd: "1.000000000" })
		expect(report.requests.find((row) => row.requestId === "follow-up")?.pullRequestIds).toEqual([second?.key])
	})

	describe("planning before the first merge", () => {
		// The review's fixture: planning without edits, then implementation that landed natively in PR 1.
		const segment = (id: string, attribution = "session", reason = "new-task") => ({ id, attribution, reason })
		const plan = (attribution?: string, reason?: string) =>
			request("plan", "work-a", "session-a", time(5), { segment: segment("input-plan", attribution, reason) })
		const implement = request("implement", "work-a", "session-a", time(10), { segment: segment("input-implement") })
		const edit = nativeEdit("implement", { path: "a.ts" })
		const firstCommit = contribution(edit)
		const followUp = request("follow-up", "work-a", "session-a", time(35), { segment: segment("input-follow-up") })
		const followUpCommit = (fields: Record<string, unknown> = {}) =>
			commit(
				"work-a",
				[{ ...secondPull(), state: "open", mergeCommitSha: null, mergedAt: null, closedAt: null }],
				"session-a",
				{ sha: "c".repeat(40), recordedAt: time(36), ...fields },
			)
		const prices = [charge("plan", "2"), charge("implement", "1"), charge("follow-up", "4")]
		const first = (report: ReturnType<typeof calculatePullRequestCosts>) =>
			report.pullRequests.find((row) => row.pullRequest?.number === 1)
		const allocated = (report: ReturnType<typeof calculatePullRequestCosts>, requestId: string) =>
			report.requests.find((row) => row.requestId === requestId)

		it("keeps the first PR's complete total after a follow-up PR opens from the same work", () => {
			const before = calculatePullRequestCosts([plan(), implement, edit, firstCommit], prices)
			const after = calculatePullRequestCosts(
				[plan(), implement, edit, firstCommit, followUp, followUpCommit()],
				prices,
			)
			for (const report of [before, after])
				expect(first(report)).toMatchObject({
					totalCostUsd: "3.000000000",
					explicit: { requestIds: ["implement"], totalCostUsd: "1.000000000" },
					inferred: { requestIds: ["plan"], totalCostUsd: "2.000000000" },
					sharedRequestIds: [],
				})
			expect(allocated(after, "plan")).toMatchObject({ allocation: "inferred", pullRequestIds: [first(after)?.key] })
			expect(allocated(after, "follow-up")).toMatchObject({ allocation: "unmerged" })
			expect(after.unallocated.shared.requestIds).toEqual([])
		})
		it("never makes an explicitly planned request confirmed through follow-up timing", () => {
			const records = [plan("explicit", "saved-plan"), implement, edit, firstCommit]
			expect(allocated(calculatePullRequestCosts(records, prices), "plan")?.allocation).toBe("pull-request")
			const after = calculatePullRequestCosts([...records, followUp, followUpCommit()], prices)
			expect(allocated(after, "plan")?.allocation).toBe("inferred")
			expect(first(after)).toMatchObject({
				totalCostUsd: "3.000000000",
				explicit: { requestIds: ["implement"] },
				inferred: { requestIds: ["plan"] },
			})
		})
		it.each([
			["a commit recorded before the merge", followUpCommit({ recordedAt: time(25) })],
			["a rebased commit whose original came before the merge", followUpCommit({ rewrittenFrom: "d".repeat(40) })],
		])("keeps planning shared with a PR that has %s", (_case, secondCommit) => {
			const original = commit("work-a", [], "session-a", { sha: "d".repeat(40), recordedAt: time(25) })
			const report = calculatePullRequestCosts(
				[plan(), implement, edit, firstCommit, original, followUp, secondCommit],
				prices,
			)
			expect(allocated(report, "plan")).toMatchObject({ allocation: "shared" })
			expect(first(report)).toMatchObject({ totalCostUsd: null, sharedRequestIds: ["plan"] })
		})
	})
	it("keeps a post-merge request's bucket but marks a bill from another account", () => {
		const other = { ...testScope.account, userId: "50000000-0000-4000-8000-000000000005" }
		const report = calculatePullRequestCosts(
			[request("before"), request("late", "work-a", "session-a", time(35)), commit()],
			[charge("before", "1"), { ...charge("late", "2"), account: other }],
		)
		expect(report.requests.find((row) => row.requestId === "late")).toMatchObject({
			allocation: "post-merge",
			reason: "work-account-mismatch",
		})
	})
})

describe("work-matching side calls", () => {
	it("keeps a merged PR total complete when matching calls ran before the input's decision", () => {
		const report = calculatePullRequestCosts(
			[
				// Recorded while the input's provisional segment was still unresolved (work-attribution.ts input handler).
				request("matching", "work-a", "session-a", time(9), {
					purpose: "work-matching",
					segment: { id: "input", attribution: "unknown", reason: "matching-unresolved" },
				}),
				request("main", "work-a", "session-a", time(10), {
					segment: { id: "input", attribution: "session", reason: "new-task" },
				}),
				commit(),
			],
			[charge("matching", "0.001"), charge("main", "1")],
		)
		expect(report.pullRequests[0].unknownRequestIds).toEqual([])
		expect(report.pullRequests[0].totalCostUsd).not.toBeNull()
	})
})

describe("exclusive allocation with tool-observed edits", () => {
	const second = pullRequest({
		number: 2,
		url: "https://github.com/example/repository/pull/2",
		mergedAt: time(50),
		closedAt: time(50),
		checkedAt: time(55),
	})
	const edit: WorkRecord = {
		version: 1,
		type: "file_transition",
		workId: "work-a",
		sessionId: "session-a",
		requestId: "r",
		transitionId: "edit-r",
		toolCallId: "edit-tool",
		cwd: "/repo",
		repository: "/repo/.git",
		worktree: "/repo",
		path: "a.ts",
		baseline: "c".repeat(40),
		baselineFile: { blob: "d".repeat(40), mode: "100644" },
		before: { blob: "d".repeat(40), mode: "100644" },
		after: { blob: "e".repeat(40), mode: "100644" },
		cursor: { bytes: 100, digest: "f".repeat(64) },
	}
	const nativeCommit = commit("work-a", [pullRequest()], "session-a", {
		source: "native-file-transition",
		paths: ["a.ts"],
		transitionIds: ["edit-r"],
		fileMatches: [{ path: "a.ts", worktree: "/repo", method: "file-chain", transitionIds: ["edit-r"] }],
	})
	// The same request also ran a Bash command; its commit landed in PR 2.
	const bashCommit = commit("work-a", [second], "session-a", {
		sha: "9".repeat(40),
		toolCallId: "bash-tool",
		requestId: "r",
	})
	it.each([
		[
			"a complete Bash observation",
			{ complete: true, files: [{ path: "b.ts", before: null, after: { blob: "1".repeat(40), mode: "100644" } }] },
		],
		["an incomplete Bash observation", { complete: false, files: [], reason: "incomplete-snapshot" }],
	])("keeps a request shared when %s shows it also wrote outside its native edits", (_case, fields) => {
		const observation: WorkRecord = {
			version: 1,
			type: "file_observation",
			workId: "work-a",
			sessionId: "session-a",
			observationId: "obs-1",
			source: "bash",
			toolCallId: "bash-tool",
			requestId: "r",
			repository: "/repo/.git",
			worktree: "/repo",
			startedAt: time(11),
			...fields,
		}
		const report = calculatePullRequestCosts(
			[request("r"), edit, nativeCommit, observation, bashCommit],
			[charge("r", "1")],
		)
		expect(report.requests[0].allocation).toBe("shared")
	})

	it.each([
		["a file no native edit touched", { files: [{ path: "dist/out.js" }] }, "pull-request"],
		["the natively edited file", { files: [{ path: "a.ts" }] }, "inferred"],
		["an incomplete scan", { complete: false, files: [], reason: "incomplete-snapshot" }, "inferred"],
		["a truncated scan", { files: [{ path: "dist/out.js" }], changedPaths: 200, truncated: true }, "inferred"],
	])("lets a Bash change to %s decide whether native proof stands", (_case, fields, allocation) => {
		const changed = (file: { path: string }) => ({
			...file,
			before: null,
			after: { blob: "1".repeat(40), mode: "100644" },
		})
		const observation: WorkRecord = {
			version: 1,
			type: "file_observation",
			workId: "work-a",
			sessionId: "session-a",
			observationId: "obs-1",
			source: "bash",
			toolCallId: "bash-tool",
			requestId: "r",
			repository: "/repo/.git",
			worktree: "/repo",
			startedAt: time(11),
			complete: true,
			...fields,
			files: fields.files.map(changed),
		}
		const segment = { id: "input", attribution: "session", reason: "new-task" }
		const report = calculatePullRequestCosts(
			[request("r", "work-a", "session-a", time(10), { segment }), edit, nativeCommit, observation],
			[charge("r", "1")],
		)
		expect(report.requests[0].allocation).toBe(allocation)
	})

	it("keeps a request shared when its Bash commit belongs to another PR without an observation", () => {
		const report = calculatePullRequestCosts([request("r"), edit, nativeCommit, bashCommit], [charge("r", "1")])
		expect(report.requests[0].allocation).toBe("shared")
	})

	it.each([
		["an empty PR lookup", { pullRequests: [] }],
		["no PR lookup yet", { pullRequests: undefined }],
	])("keeps native proof unconfirmed while the input's own Bash commit has %s", (_case, fields) => {
		// Discovery may still find it, or it was squashed outside Kimchi and never reaches a PR.
		const segment = { id: "input", attribution: "session", reason: "new-task" }
		const confirmed = calculatePullRequestCosts(
			[request("r", "work-a", "session-a", time(10), { segment }), edit, nativeCommit],
			[charge("r", "1")],
		)
		expect(confirmed.requests[0].allocation).toBe("pull-request")
		const report = calculatePullRequestCosts(
			[request("r", "work-a", "session-a", time(10), { segment }), edit, nativeCommit, { ...bashCommit, ...fields }],
			[charge("r", "1")],
		)
		expect(report.requests[0].allocation).toBe("inferred")
		expect(report.pullRequests[0]).toMatchObject({ totalCostUsd: "1.000000000", explicit: { requestIds: [] } })
	})

	it.each([
		{ name: "same PR", pull: pullRequest(), allocation: "pull-request" },
		{ name: "other PR", pull: second, allocation: "shared" },
	])("checks a local child's Bash commit to the $name for the whole input", ({ pull, allocation }) => {
		const segment = { id: "input", attribution: "session", reason: "new-task" }
		const report = calculatePullRequestCosts(
			[
				request("r", "work-a", "session-a", time(10), { segment }),
				request("child", "work-a", "child-session", time(11), { segment }),
				edit,
				nativeCommit,
				{ ...bashCommit, sessionId: "child-session", requestId: "child", pullRequests: [pull] },
			],
			[charge("r", "1"), charge("child", "2")],
		)
		expect(report.requests.map((row) => row.allocation)).toEqual([allocation, allocation])
	})

	it.each(["bash", "mcp"])("keeps the whole input inferred when a child's %s observation is incomplete", (source) => {
		const segment = { id: "input", attribution: "session", reason: "new-task" }
		const report = calculatePullRequestCosts(
			[
				request("r", "work-a", "session-a", time(10), { segment }),
				request("child", "work-a", "child-session", time(11), { segment }),
				edit,
				nativeCommit,
				{
					version: 1,
					type: "file_observation",
					workId: "work-a",
					sessionId: "child-session",
					requestId: "child",
					observationId: "child-observation",
					toolCallId: "child-tool",
					source,
					repository: "/repo/.git",
					worktree: "/repo",
					complete: false,
					files: [],
				},
			],
			[charge("r", "1"), charge("child", "2")],
		)
		expect(report.requests.map((row) => row.allocation)).toEqual(["inferred", "inferred"])
		expect(report.pullRequests[0]).toMatchObject({
			totalCostUsd: "3.000000000",
			explicit: { requestIds: [] },
			inferred: { totalCostUsd: "3.000000000" },
		})
	})

	it("does not treat a Bash commit alone as native input evidence", () => {
		const report = calculatePullRequestCosts(
			[
				request("r", "work-a", "session-a", time(10), {
					segment: { id: "input", attribution: "session", reason: "new-task" },
				}),
				bashCommit,
			],
			[charge("r", "1")],
		)
		expect(report.requests[0].allocation).toBe("inferred")
	})
})
