import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as json from "../../config/json.js"
import * as config from "../../config.js"
import { createContext } from "../__mocks__/context.js"
import { savedWorkSummary } from "../__mocks__/work-summary.js"
import { appendWorkRecord, getWorkId } from "../work-attribution.js"
import { captureBillingSource, requestTagSelector } from "./billing-source.js"
import { workCostDetails } from "./cost-details.js"
import { readWorkCostReport, reconcileWorkCosts } from "./cost-sync.js"
import * as costs from "./costs.js"
import { calculatePullRequestCosts } from "./costs.js"
import * as summary from "./summary.js"
import { flushWorkSummaries, readWorkRecords, recoverWorkSummaries, type WorkRecord } from "./summary.js"

vi.mock("../../config.js", async (original) => ({ ...(await original<typeof config>()) }))
vi.mock("../../config/json.js", async (original) => ({ ...(await original<typeof json>()) }))
vi.mock("node:fs", async (original) => ({ ...(await original<typeof fs>()) }))
vi.mock("./costs.js", async (original) => ({ ...(await original<typeof costs>()) }))
vi.mock("./summary.js", async (original) => ({ ...(await original<typeof summary>()) }))

const API = "https://billing.example/api"
const GATEWAY = "https://gateway.example/openai/v1/chat/completions"
const PROMPT = "11111111-2222-4333-8444-555555555555"
const ROW = "22222222-2222-4333-8444-555555555555"
const ORG = "33333333-2222-4333-8444-555555555555"
/** Past the priced recheck interval for a request dispatched four hours before the test clock. */
const RECHECK_MS = 20 * 60_000
let dir: string
let currentKey: string
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"))
	dir = mkdtempSync(join(tmpdir(), "kimchi-cost-sync-"))
	currentKey = "test-only-original-key"
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
	const originalConfig = config.loadConfig()
	const endpoints = config.resolveEndpoints()
	vi.spyOn(config, "loadConfig").mockImplementation(() => ({ ...originalConfig, apiKey: currentKey }))
	vi.spyOn(config, "resolveEndpoints").mockReturnValue({
		...endpoints,
		platformApiUrl: API,
		openAiBaseUrl: "https://gateway.example/openai/v1",
		anthropicBaseUrl: "https://gateway.example/anthropic",
		experimentalOpenAiBaseUrl: "https://gateway.example/experimental/openai/v1",
		llmEndpoint: "https://gateway.example/openai/v1",
	})
	fetchMock.mockReset()
	fetchMock.mockImplementation(async (input) =>
		String(input).endsWith("api-keys:verify")
			? Response.json({ organizationId: ORG, userId: PROMPT })
			: Response.json({ items: [{ id: ROW, totalPrice: "0.123456789" }], nextPageCursor: "" }),
	)
	vi.stubGlobal("fetch", fetchMock)
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	vi.useRealTimers()
	rmSync(dir, { recursive: true, force: true })
})

/** A work with one request and, unless `numbers` is empty, a commit in those merged PRs. */
function tracked(sessionId: string, requestId: string, fields: Record<string, unknown> = {}, numbers = [1]) {
	const ctx = createContext({ cwd: dir, sessionManager: { getSessionId: () => sessionId } })
	const workId = getWorkId(ctx)
	const source = captureBillingSource(new Headers({ Authorization: `Bearer ${currentKey}` }), GATEWAY, dir)
	appendWorkRecord(ctx, {
		type: "request",
		requestId,
		startedAt: "2026-10-01T08:00:00Z",
		scope: { account: { apiUrl: API, organizationId: ORG, userId: PROMPT }, repository: join(dir, ".git") },
		...fields,
	})
	if (numbers.length)
		appendWorkRecord(ctx, {
			type: "commit",
			sha: "a".repeat(40),
			repository: join(dir, ".git"),
			worktree: dir,
			pullRequests: numbers.map((number) => ({
				provider: "github",
				host: "github.com",
				repository: "example/repo",
				number,
				url: `https://github.com/example/repo/pull/${number}`,
				state: "merged",
				headSha: "a".repeat(40),
				mergeCommitSha: "b".repeat(40),
				mergedAt: "2026-10-01T09:00:00Z",
				closedAt: "2026-10-01T09:00:00Z",
				checkedAt: "2026-10-01T10:00:00Z",
			})),
		})
	return { ctx, workId, source }
}
function report(workId: string) {
	return JSON.parse(readFileSync(join(dir, "work", workId, "costs.json"), "utf8"))
}
function sync() {
	return reconcileWorkCosts(dir, new AbortController().signal)
}
function tagged(
	sessionId = "tagged",
	requestId: string = randomUUID(),
	fields: Record<string, unknown> = {},
	numbers = [1],
) {
	const result = tracked(sessionId, requestId, fields, numbers)
	const dispatchedAt = "2026-10-01T08:00:00.000Z"
	const selector = requestTagSelector(requestId, dispatchedAt)
	appendWorkRecord(result.ctx, {
		type: "request_dispatch",
		requestId,
		dispatchedAt,
		billingSource: result.source,
		billingSelector: selector,
	})
	return { ...result, requestId, selector }
}
/** Bills `requestId` USD 1 and every other request USD 2. */
function billOneThenTwo(requestId: string) {
	fetchMock.mockImplementation(async (input) => {
		const url = new URL(String(input))
		if (url.pathname.endsWith("api-keys:verify")) return Response.json({ organizationId: ORG, userId: PROMPT })
		const first = url.searchParams.get("tags") === `kimchi-request:${requestId}`
		return Response.json({ items: [{ id: first ? ROW : ORG, totalPrice: first ? "1" : "2" }] })
	})
}

describe("automatic exact work cost lookup", () => {
	it("saves every request contributing to a PR total across works", async () => {
		const first = tagged("first")
		const second = tagged("second")
		billOneThenTwo(first.requestId)
		await sync()
		for (const { workId } of [first, second]) {
			const saved = report(workId)
			expect(saved.pullRequests[0].totalCostUsd).toBe("3.000000000")
			expect(saved.requests.map((row: { requestId: string }) => row.requestId)).toEqual(
				[first.requestId, second.requestId].sort(),
			)
		}
	})

	it("saves every transitively connected work's requests and PR totals in each work's report", async () => {
		// The first and last works share no PR; the middle work's commit is in both PRs.
		const works = [tagged("first"), tagged("middle", randomUUID(), {}, [1, 2]), tagged("last", randomUUID(), {}, [2])]
		await sync()
		for (const { workId } of works) {
			const { requests, pullRequests } = report(workId)
			expect(requests.map((row: { requestId: string }) => row.requestId)).toEqual(
				works.map(({ requestId }) => requestId).sort(),
			)
			expect(pullRequests.map((row: { pullRequest: { number: number } }) => row.pullRequest.number)).toEqual([1, 2])
		}
	})

	it("connects works through a correction link when the linked work has no PR", async () => {
		const requestId = randomUUID()
		const source = tagged("source", requestId)
		const target = tagged("target", randomUUID(), {}, [])
		appendWorkRecord(target.ctx, {
			type: "work_link",
			linkId: randomUUID(),
			revision: 1,
			sourceWorkId: source.workId,
			targetWorkId: target.workId,
			requestIds: [requestId],
			scope: { account: { apiUrl: API, organizationId: ORG, userId: PROMPT }, repository: join(dir, ".git") },
			status: "active",
			evidence: { source: "work-command" },
		})
		await sync()
		for (const { workId } of [source, target])
			expect(report(workId).requests.map((row: { requestId: string }) => row.requestId)).toEqual(
				[requestId, target.requestId].sort(),
			)
	})

	it("prices only the work's own requests in /work while its PR total includes connected works", async () => {
		const first = tagged("first")
		tagged("second")
		billOneThenTwo(first.requestId)
		await sync()
		const lines = workCostDetails(dir, first.workId)
		expect(lines).toContain("Cost: $3.000000000 USD — https://github.com/example/repo/pull/1")
		// Without an input record, the request counts as inferred.
		expect(lines).toContain(
			"Prices: 1/1 requests priced, $1.000000000 USD. PR assignments: 0 unresolved, 1 inferred, 0 shared.",
		)
	})

	it("saves only the selected work's unrelated requests in its aggregate buckets", async () => {
		const works = ["first", "second"].map((sessionId) => {
			const ctx = createContext({ cwd: dir, sessionManager: { getSessionId: () => sessionId } })
			const workId = getWorkId(ctx)
			appendWorkRecord(ctx, {
				type: "request",
				requestId: sessionId,
				startedAt: "2026-10-01T08:00:00Z",
			})
			return { workId, requestId: sessionId }
		})
		await sync()
		for (const { workId, requestId } of works) {
			const saved = report(workId)
			expect(saved.requests.map((row: { requestId: string }) => row.requestId)).toEqual([requestId])
			expect(saved.unallocated).toMatchObject({
				unknown: { requestIds: [requestId], knownCostUsd: "0.000000000", totalCostUsd: null },
				inferred: { requestIds: [], knownCostUsd: "0.000000000", totalCostUsd: "0.000000000" },
				shared: { requestIds: [] },
				unlinked: { requestIds: [] },
				unmerged: { requestIds: [] },
				"post-merge": { requestIds: [] },
			})
		}
	})

	it("reads reporting inventory from validated source records instead of editable per-work caches", async () => {
		const { workId } = tagged()
		await sync()
		writeFileSync(join(dir, "work", workId, "costs.json"), '{"requests":[],"pullRequests":[]}')
		const source = readWorkCostReport(dir)
		expect(source.report.requests).toHaveLength(1)
		expect(source.report.requests[0]).toMatchObject({ billingRecordIds: [ROW], totalCostUsd: "0.123456789" })
	})
	it("labels separate accounts when a work view contains the same PR more than once", async () => {
		const { workId } = tagged()
		await sync()
		const saved = report(workId)
		saved.pullRequests.push({
			...saved.pullRequests[0],
			account: null,
			knownCostUsd: "0.000000000",
			totalCostUsd: null,
		})
		writeFileSync(join(dir, "work", workId, "costs.json"), JSON.stringify(saved))
		const lines = workCostDetails(dir, workId)
		expect(lines).toContain(`Account: ${ORG} / ${PROMPT} (${API})`)
		expect(lines).toContain("Account: unknown")
	})

	it("shows an open PR's spend so far and keeps it unknown until every request is priced", () => {
		const workId = randomUUID()
		const account = { apiUrl: API, organizationId: ORG, userId: PROMPT }
		const pullRequest = {
			provider: "github",
			host: "github.com",
			repository: "example/repo",
			number: 1,
			url: "https://github.com/example/repo/pull/1",
			state: "open",
			headSha: "a".repeat(40),
			mergeCommitSha: null,
			mergedAt: null,
			closedAt: null,
			checkedAt: "2026-10-01T10:00:00Z",
		}
		const records: WorkRecord[] = [
			{
				version: 1,
				type: "request",
				workId,
				sessionId: "session",
				requestId: "open",
				recordedAt: "2026-10-01T08:00:00Z",
				scope: { account, repository: join(dir, ".git") },
			},
			{
				version: 1,
				type: "commit",
				workId,
				sessionId: "session",
				sha: "a".repeat(40),
				repository: join(dir, ".git"),
				worktree: dir,
				recordedAt: "2026-10-01T09:00:00Z",
				pullRequests: [pullRequest],
			},
		]
		const save = (observations: Parameters<typeof calculatePullRequestCosts>[1]) => {
			const costs = calculatePullRequestCosts(records, observations)
			mkdirSync(join(dir, "work", workId), { recursive: true })
			writeFileSync(join(dir, "work", workId, "costs.json"), JSON.stringify({ version: 1, workId, ...costs }))
		}
		save([])
		expect(workCostDetails(dir, workId)).toContain(
			"Cost so far: unknown; $0.000000000 USD priced (open) — https://github.com/example/repo/pull/1",
		)
		save([{ requestId: "open", billingRecordId: ROW, costUsd: "0.5", account }])
		const lines = workCostDetails(dir, workId)
		expect(lines).toContain("Cost so far: $0.500000000 USD (open) — https://github.com/example/repo/pull/1")
		expect(lines.join("\n")).not.toContain("Confirmed:")
	})

	it("keeps a legacy request's exact price without assigning today's account to its work", async () => {
		const { workId } = tagged("legacy", randomUUID(), { scope: undefined })
		await sync()
		expect(report(workId).requests[0]).toMatchObject({
			account: null,
			allocation: "unknown",
			reason: "work-account-unverified",
			totalCostUsd: "0.123456789",
		})
		expect(report(workId).pullRequests[0]).toMatchObject({
			account: null,
			requestIds: [],
			knownCostUsd: "0.000000000",
			totalCostUsd: null,
		})
	})
	it.each([
		"organization",
		"user",
		"same-account",
	])("persists separate account totals for one PR after restart: %s", async (kind) => {
		const first = { apiUrl: API, organizationId: ORG, userId: PROMPT }
		const second = { ...first }
		if (kind === "organization") second.organizationId = ROW
		if (kind === "user") second.userId = ROW
		const requestIds = [randomUUID(), randomUUID()]
		const works = [first, second].map((account, index) => {
			currentKey = `test-only-account-${index}`
			const requestId = requestIds[index]
			const saved = tagged(`session-${index}`, requestId, {
				scope: { account, repository: join(dir, ".git") },
			})
			appendWorkRecord(saved.ctx, {
				type: "request_cost",
				requestId,
				billingSource: saved.source,
				billingSelector: saved.selector,
				billingRows: [{ id: index === 0 ? ROW : ORG, costUsd: String(index + 1) }],
				billingLookup: {
					status: "priced",
					checkedAt: new Date().toISOString(),
					organizationId: account.organizationId,
					userId: account.userId,
				},
			})
			return saved.workId
		})
		await sync()
		for (const [index, workId] of works.entries()) {
			const saved = report(workId)
			expect(saved.requests).toHaveLength(kind === "same-account" ? 2 : 1)
			expect(saved.pullRequests).toHaveLength(1)
			expect(saved.pullRequests[0]).toMatchObject({
				account: index === 0 ? first : second,
				requestIds: kind === "same-account" ? [...requestIds].sort() : [requestIds[index]],
				workIds: kind === "same-account" ? [...works].sort() : [workId],
				totalCostUsd: kind === "same-account" ? "3.000000000" : `${index + 1}.000000000`,
			})
			unlinkSync(join(dir, "work", workId, "costs.json"))
		}
		await sync()
		expect(report(works[0]).pullRequests[0].totalCostUsd).toBe(kind === "same-account" ? "3.000000000" : "1.000000000")
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("shows inferred PR ownership separately from an exact price", async () => {
		const account = { apiUrl: API, organizationId: ORG, userId: PROMPT }
		const { workId } = tagged("inferred", randomUUID(), {
			scope: { account, repository: join(dir, ".git") },
			segment: { id: "input", attribution: "inferred", reason: "model-continue" },
		})
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		await sync()
		expect(report(workId).requests[0]).toMatchObject({
			priceStatus: "priced",
			allocation: "inferred",
			totalCostUsd: "0.123456789",
		})
		expect(workCostDetails(dir, workId)).toContain("Cost: $0.123456789 USD — https://github.com/example/repo/pull/1")
		expect(workCostDetails(dir, workId)).toContain(
			"Prices: 1/1 requests priced, $0.123456789 USD. PR assignments: 0 unresolved, 1 inferred, 0 shared.",
		)
		expect(workCostDetails(dir, workId)).toContain("Confirmed: $0.000000000 USD; inferred: $0.123456789 USD.")
	})

	it("counts requests sent without a billing tag by reason in work details", async () => {
		const untagged = (reason: string) => {
			const requestId = randomUUID()
			const { ctx, workId, source } = tracked("untagged", requestId)
			appendWorkRecord(ctx, {
				type: "request_dispatch",
				requestId,
				dispatchedAt: "2026-10-01T08:00:00.000Z",
				billingSource: source,
				billingTagSkipped: reason,
			})
			return workId
		}
		const workId = untagged("tag-limit")
		untagged("tag-limit")
		untagged("tag-limit")
		await sync()
		expect(fetchMock).not.toHaveBeenCalled()
		expect(report(workId).requests.map((row: { billingTagSkipped: string }) => row.billingTagSkipped)).toEqual([
			"tag-limit",
			"tag-limit",
			"tag-limit",
		])
		expect(workCostDetails(dir, workId)).toContain(
			"3 requests untagged: tag limit (Kimchi adds model and phase tags; keep at most 7 in /tags).",
		)
		untagged("body-uninspectable")
		await sync()
		expect(workCostDetails(dir, workId)).toContain(
			"4 requests untagged: 1 body uninspectable, 3 tag limit (Kimchi adds model and phase tags; keep at most 7 in /tags).",
		)
	})
	it("counts only the work's own untagged and failed requests in work details of connected works", async () => {
		const untaggedId = randomUUID()
		const untagged = tracked("untagged", untaggedId)
		appendWorkRecord(untagged.ctx, {
			type: "request_dispatch",
			requestId: untaggedId,
			dispatchedAt: "2026-10-01T08:00:00.000Z",
			billingSource: untagged.source,
			billingTagSkipped: "tag-limit",
		})
		const priced = tagged("priced")
		await sync()
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + RECHECK_MS)
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
		await sync()
		// Both works share PR #1, so each saved report lists both requests.
		expect(report(untagged.workId).requests).toHaveLength(2)
		const untaggedLines = workCostDetails(dir, untagged.workId)
		expect(untaggedLines).toContain(
			"1 request untagged: tag limit (Kimchi adds model and phase tags; keep at most 7 in /tags).",
		)
		expect(untaggedLines.join("\n")).not.toContain("Last billing refresh failed")
		const pricedLines = workCostDetails(dir, priced.workId)
		expect(pricedLines).toContain("Last billing refresh failed for 1 request: Billing API returned HTTP 503.")
		expect(pricedLines.join("\n")).not.toContain("untagged")
	})
	it("shows price coverage and unresolved ownership separately in work details", async () => {
		const { ctx, workId } = tagged("details", randomUUID(), {
			segment: { id: "uncertain", attribution: "unknown", reason: "model-uncertain" },
		})
		appendWorkRecord(ctx, { type: "request", requestId: "not-billed", startedAt: "2026-10-01T08:00:00Z" })
		await sync()
		expect(workCostDetails(dir, workId)).toContain(
			"Prices: 1/2 requests priced, $0.123456789 USD known so far. PR assignments: 2 unresolved, 0 inferred, 0 shared.",
		)
	})
	it("refreshes both work views after a correction and revocation without duplicating bills", async () => {
		const scope = { account: { apiUrl: API, organizationId: ORG, userId: PROMPT }, repository: join(dir, ".git") }
		const requestId = randomUUID()
		const plan = tagged("planning", requestId, { scope })
		const implementation = tagged("implementation", randomUUID(), { scope })
		const link = {
			type: "work_link",
			linkId: randomUUID(),
			revision: 1,
			sourceWorkId: plan.workId,
			targetWorkId: implementation.workId,
			requestIds: [requestId],
			scope,
			status: "active",
			evidence: { source: "work-command" },
		}
		appendWorkRecord(implementation.ctx, link)
		billOneThenTwo(requestId)
		await sync()
		expect(report(implementation.workId).requests).toHaveLength(2)
		expect(report(implementation.workId).pullRequests[0].totalCostUsd).toBe("3.000000000")
		expect(
			report(plan.workId).requests.find((row: { requestId: string }) => row.requestId === requestId),
		).toMatchObject({
			workIds: [plan.workId],
			linkedWorkIds: [implementation.workId],
			totalCostUsd: "1.000000000",
		})
		// The linked request counts for both works; the plan does not count the implementation's own request.
		expect(workCostDetails(dir, plan.workId)).toContain(
			"Prices: 1/1 requests priced, $1.000000000 USD. PR assignments: 0 unresolved, 0 inferred, 0 shared.",
		)
		// The implementation's own request has no input record; the linked one is confirmed by the link.
		expect(workCostDetails(dir, implementation.workId)).toContain(
			"Prices: 2/2 requests priced, $3.000000000 USD. PR assignments: 0 unresolved, 1 inferred, 0 shared.",
		)
		appendWorkRecord(implementation.ctx, { ...link, revision: 2, status: "revoked" })
		await sync()
		const revoked = report(implementation.workId)
		expect(revoked.pullRequests[0]).toMatchObject({
			knownCostUsd: "2.000000000",
			totalCostUsd: null,
			unknownRequestIds: [requestId],
		})
		unlinkSync(join(dir, "work", implementation.workId, "costs.json"))
		await sync()
		expect(report(implementation.workId)).toEqual(revoked)
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})
	it.each([
		"organization",
		"user",
		"endpoint",
		"missing-user",
		"same-account",
	])("keeps the exact bill but checks the work account after %s at dispatch", async (change) => {
		const account = { apiUrl: API, organizationId: ORG, userId: PROMPT }
		if (change === "organization") account.organizationId = ROW
		if (change === "user") account.userId = ROW
		if (change === "endpoint") account.apiUrl = "https://other.example/api"
		const { workId, requestId } = tagged("session", randomUUID(), {
			scope: { account, repository: join(dir, ".git") },
		})
		fetchMock.mockResolvedValueOnce(
			Response.json({ organizationId: ORG, ...(change === "missing-user" ? {} : { userId: PROMPT }) }),
		)
		await sync()
		const costs = report(workId)
		expect(costs.requests[0]).toMatchObject({
			priceStatus: "priced",
			totalCostUsd: "0.123456789",
			allocation: change === "same-account" ? "inferred" : "unknown",
		})
		if (change !== "same-account") {
			expect(costs.requests[0].reason).toBe(
				change === "missing-user" ? "work-account-unverified" : "work-account-mismatch",
			)
			expect(costs.pullRequests[0]).toMatchObject({
				requestIds: [],
				unknownRequestIds: [requestId],
				totalCostUsd: null,
			})
		}
		await sync()
		expect(report(workId)).toEqual(costs)
	})

	it("retains safe billed metadata through source records, work.json and recovery", async () => {
		const { workId } = tagged()
		const metadata = {
			sessionId: ROW,
			parentSessionId: ORG,
			createTime: "2026-10-01T08:00:01.123456789Z",
			provider: "ai-enabler",
			providerName: "configured-provider",
			model: "served-model",
			originalModel: "requested-model",
			recommendedModel: "recommended-model",
			recommendedProvider: "other-provider",
			routed: true,
			recovered: false,
			responseStatusCode: 200,
			promptTokens: "18446744073709551615",
			completionTokens: "7",
			totalTokens: "9007199254740993",
			cacheReadInputTokens: "100",
			cacheCreationFiveMinuteTokens: "0",
			cacheCreationOneHourTokens: "3",
			webSearchRequests: "0",
			promptPrice: "0.100000001",
			completionPrice: "0.020000002",
			cacheReadPrice: "0.003456786",
			cacheCreationPrice: "0",
			originalTotalPrice: "0.2",
			recommendedTotalPrice: "0.05",
			messageCount: 12,
			contextWindowSize: 200000,
			turnIndex: 4,
			contextUtilizationPct: 55.25,
		}
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(
			Response.json({
				items: [
					{
						id: ROW,
						totalPrice: "0.123456789",
						...metadata,
						completionTokens: 7,
						promptId: PROMPT,
						promptPreview: "DO_NOT_SAVE",
						authorization: "DO_NOT_SAVE",
						apiKeyAlias: "DO_NOT_SAVE",
						workloadLabels: { secret: "DO_NOT_SAVE" },
						unknownField: "DO_NOT_SAVE",
					},
				],
			}),
		)
		await sync()
		const expected = { id: ROW, costUsd: "0.123456789", ...metadata }
		expect(readWorkRecords(dir).find((row) => row.type === "request_cost")?.billingRows).toEqual([expected])
		await flushWorkSummaries()
		expect(savedWorkSummary(dir, workId).requests[0].billingRows).toEqual([expected])
		writeFileSync(join(dir, "work", workId, "work.json"), "damaged")
		recoverWorkSummaries()
		await flushWorkSummaries()
		expect(savedWorkSummary(dir, workId).requests[0].billingRows).toEqual([expected])
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.123456789")
		expect(JSON.stringify(readWorkRecords(dir))).not.toContain("DO_NOT_SAVE")
	})
	it.each([
		["0", "0"],
		["18446744073709551615", "18446744073709551615"],
		[9007199254740991, "9007199254740991"],
		[9007199254740992, undefined],
		["18446744073709551616", undefined],
		[-1, undefined],
		[1.5, undefined],
		["1e3", undefined],
	])("retains exact counter %s or marks only that metadata unavailable", async (value, expected) => {
		const { workId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(Response.json({ items: [{ id: ROW, totalPrice: "0", promptTokens: value }] }))
		await sync()
		const row = readWorkRecords(dir).find((row) => row.type === "request_cost")?.billingRows
		expect(row).toEqual([
			{
				id: ROW,
				costUsd: "0",
				...(expected === undefined ? { metadataUnavailable: ["promptTokens"] } : { promptTokens: expected }),
			},
		])
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.000000000")
	})
	it("keeps absent metadata unknown and never saves malformed optional values", async () => {
		tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(
			Response.json({
				items: [
					{
						id: ROW,
						totalPrice: "1",
						promptPrice: "NaN",
						completionPrice: "0.0000000001",
						cacheReadPrice: 0.1,
						cacheCreationPrice: null,
						completionTokens: null,
						createTime: "2026-02-31T08:00:00Z",
						model: "DO_NOT_SAVE\n",
						sessionId: "DO_NOT_SAVE",
						routed: "yes",
						responseStatusCode: -1,
						contextUtilizationPct: -2,
					},
				],
			}),
		)
		await sync()
		const rows = readWorkRecords(dir).find((row) => row.type === "request_cost")?.billingRows
		expect(rows).toEqual([
			{
				id: ROW,
				costUsd: "1",
				metadataUnavailable: [
					"cacheReadPrice",
					"completionPrice",
					"contextUtilizationPct",
					"createTime",
					"model",
					"promptPrice",
					"responseStatusCode",
					"routed",
					"sessionId",
				],
			},
		])
		expect(JSON.stringify(readWorkRecords(dir))).not.toContain("DO_NOT_SAVE")
	})
	it("enriches legacy billed rows without changing price totals or losing earlier evidence", async () => {
		const { workId } = tagged()
		await sync()
		const now = Date.now()
		vi.spyOn(Date, "now").mockReturnValue(now + RECHECK_MS)
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		const enriched = { id: ROW, totalPrice: "0.123456789", promptTokens: "100", cacheReadPrice: "0" }
		fetchMock.mockResolvedValueOnce(Response.json({ items: [enriched, enriched], totalCount: 1 }))
		await sync()
		await flushWorkSummaries()
		const rows = savedWorkSummary(dir, workId).requests[0].billingRows
		expect(rows).toEqual([{ id: ROW, costUsd: "0.123456789", promptTokens: "100", cacheReadPrice: "0" }])
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.123456789")
		vi.mocked(Date.now).mockReturnValue(now + 2 * RECHECK_MS)
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(Response.json({ items: [enriched], totalCount: 1 }))
		await sync()
		await flushWorkSummaries()
		expect(savedWorkSummary(dir, workId).requests[0].billingRows).toEqual(rows)
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.123456789")
	})
	it.each([
		"verification-failure",
		"changed-key",
	])("retains verified account identity in the summary after %s", async (failure) => {
		const { workId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(Response.json({ items: [{ id: ROW, totalPrice: "0.1" }] }))
		await sync()
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + RECHECK_MS)
		if (failure === "changed-key") currentKey = "another-key"
		else fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
		await sync()
		await flushWorkSummaries()
		const request = savedWorkSummary(dir, workId).requests[0]
		// A failed key check returns no billing page, and a changed key cannot withdraw a verified price.
		expect(request.billingLookup).toMatchObject({
			organizationId: ORG,
			userId: PROMPT,
			status: failure === "changed-key" ? "account-changed" : "priced",
		})
		expect(report(workId).pullRequests[0]).toMatchObject({ totalCostUsd: "0.100000000", knownCostUsd: "0.100000000" })
		expect(fetchMock).toHaveBeenCalledTimes(failure === "changed-key" ? 2 : 3)
	})
	it("pins the gateway's X-API-Key account when both auth headers are present", () => {
		const original = captureBillingSource(new Headers({ "x-api-key": currentKey }), GATEWAY, dir)
		expect(
			captureBillingSource(new Headers({ "x-api-key": currentKey, Authorization: "Bearer another-key" }), GATEWAY, dir),
		).toEqual(original)
		expect(
			captureBillingSource(new Headers({ "x-api-key": "", Authorization: `Bearer ${currentKey}` }), GATEWAY, dir),
		).toBeUndefined()
	})
	it("captures Anthropic beta requests without persisting URL query data", () => {
		const gatewayUrl = "https://gateway.example/anthropic/v1/messages"
		const captured = captureBillingSource(
			new Headers({ "x-api-key": currentKey }),
			`${gatewayUrl}?beta=true&private=do-not-save`,
			dir,
		)
		expect(captured).toMatchObject({ apiUrl: API, gatewayUrl })
		expect(JSON.stringify(captured)).not.toContain("do-not-save")
		expect(
			captureBillingSource(
				new Headers({ "x-api-key": currentKey }),
				"https://user:secret@gateway.example/anthropic/v1/messages?beta=true",
				dir,
			),
		).toBeUndefined()
	})
	it("rejects an exact-tag row belonging to a different verified API key owner", async () => {
		const { workId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(
			Response.json({ items: [{ id: ROW, castaiApiKeyOwnerId: ORG, totalPrice: "0.25" }] }),
		)
		await sync()
		expect(report(workId).pullRequests[0].totalCostUsd).toBeNull()
		expect(report(workId).requests[0].billingLookup.reason).toMatch(/owner/)
	})
	it("keeps the first verified owner when the same credential later resolves to another owner", async () => {
		const { workId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(Response.json({ items: [] }))
		await sync()
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000)
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: ROW }))
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(report(workId).requests[0].billingLookup).toMatchObject({ status: "account-changed", userId: PROMPT })
	})
	it.each([
		"2026-02-31T08:00:00.000Z",
		"275760-09-13T00:00:00.000Z",
		"invalid",
	])("rejects an impossible dispatch timestamp %s", (timestamp) => {
		expect(requestTagSelector(PROMPT, timestamp)).toBeUndefined()
	})
	it.each([
		false,
		true,
	])("uses the captured exact tag with deployed price rows (response present: %s)", async (response) => {
		const { workId, requestId, ctx, source } = tagged()
		// The captured prompt ID is diagnostic only; the tag alone selects the bill.
		if (response)
			appendWorkRecord(ctx, {
				type: "request_response",
				requestId,
				billingSource: source,
				response: { promptId: PROMPT },
			})
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(Response.json({ items: [{ id: ROW, totalPrice: "0.000068350" }], totalCount: 1 }))
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(2)
		const query = new URL(String(fetchMock.mock.calls[1][0])).searchParams
		expect(Object.fromEntries(query)).toEqual({
			tags: `kimchi-request:${requestId}`,
			startTime: "2026-09-30T20:00:00.000Z",
			endTime: "2026-11-02T08:00:00.000Z",
			inferUserFromApiKey: "true",
			"page.limit": "100",
		})
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.000068350")
		expect(readWorkRecords(dir).find((row) => row.type === "request_cost")).toMatchObject({
			billingSelector: { type: "tag", tag: `kimchi-request:${requestId}` },
			billingRows: [{ id: ROW, costUsd: "0.000068350" }],
		})
	})
	it("keeps the original tag window for late billing and deduplicates overlapping pages", async () => {
		const { workId, requestId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(Response.json({ items: [] }))
		await sync()
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 90 * 24 * 60 * 60_000)
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(
			Response.json({ items: [{ id: ROW, totalPrice: "0.1" }], nextPageCursor: "next", totalCount: 2 }),
		)
		fetchMock.mockResolvedValueOnce(
			Response.json({
				items: [
					{ id: ROW, totalPrice: "0.1" },
					{ id: PROMPT, totalPrice: "0.2" },
				],
				totalCount: 2,
			}),
		)
		await sync()
		const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url))).filter((url) => url.searchParams.has("tags"))
		expect(urls).toHaveLength(3)
		expect(
			urls.every(
				(url) =>
					url.searchParams.get("tags") === `kimchi-request:${requestId}` &&
					url.searchParams.get("startTime") === "2026-09-30T20:00:00.000Z",
			),
		).toBe(true)
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.300000000")
	})
	it("keeps pricing a request dispatched with the earlier five-minute window", async () => {
		const { workId, requestId, ctx, source } = tagged()
		const dispatchedAt = "2026-10-01T09:00:00.000Z"
		const earlier = randomUUID()
		tracked("tagged", earlier)
		appendWorkRecord(ctx, {
			type: "request_dispatch",
			requestId: earlier,
			dispatchedAt,
			billingSource: source,
			billingSelector: requestTagSelector(earlier, dispatchedAt, 5 * 60_000),
		})
		fetchMock.mockImplementation(async (input) => {
			const url = new URL(String(input))
			if (url.pathname.endsWith("api-keys:verify")) return Response.json({ organizationId: ORG, userId: PROMPT })
			const tag = url.searchParams.get("tags")
			return Response.json({ items: [{ id: tag === `kimchi-request:${earlier}` ? ORG : ROW, totalPrice: "0.1" }] })
		})
		await sync()
		const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url))).filter((url) => url.searchParams.has("tags"))
		expect(urls.map((url) => [url.searchParams.get("tags"), url.searchParams.get("startTime")])).toEqual(
			expect.arrayContaining([
				[`kimchi-request:${requestId}`, "2026-09-30T20:00:00.000Z"],
				[`kimchi-request:${earlier}`, "2026-10-01T08:55:00.000Z"],
			]),
		)
		expect(report(workId).requests.find((row: { requestId: string }) => row.requestId === earlier)).toMatchObject({
			priceStatus: "priced",
		})
	})
	it.each(["owner", "tag", "window"])("rejects conflicting captured tag %s evidence", async (conflict) => {
		const { workId, requestId, ctx, source, selector } = tagged()
		appendWorkRecord(
			conflict === "owner" ? createContext({ cwd: dir, sessionManager: { getSessionId: () => "other" } }) : ctx,
			{
				type: "request_dispatch",
				requestId,
				dispatchedAt: "2026-10-01T08:00:00.000Z",
				billingSource: source,
				billingSelector: {
					...selector,
					...(conflict === "tag" ? { tag: `kimchi-request:${PROMPT}` } : {}),
					...(conflict === "window" ? { endTime: "2026-10-01T08:01:00.000Z" } : {}),
				},
			},
		)
		await sync()
		expect(fetchMock).not.toHaveBeenCalled()
		expect(report(workId).pullRequests[0].totalCostUsd).toBeNull()
	})
	it.each([
		"key",
		"organization",
	])("keeps retrying current-account billing behind many unchanged %s mismatches", async (mismatch) => {
		for (let i = 0; i < 30; i++) {
			const { ctx, source, requestId, selector } = tagged(`old-${i}`)
			appendWorkRecord(ctx, {
				type: "request_cost",
				requestId,
				billingSource: source,
				billingSelector: selector,
				billingRows: [],
				billingLookup: {
					status: "account-changed",
					checkedAt: "2026-10-01T12:00:00Z",
					reason:
						mismatch === "key"
							? "Original credential or endpoint is no longer configured"
							: "Original billing organization changed",
					...(mismatch === "organization" ? { organizationId: "44444444-2222-4333-8444-555555555555" } : {}),
				},
			})
		}
		if (mismatch === "key") currentKey = "test-only-new-account"
		const { workId, requestId } = tagged("live")
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(Response.json({ items: [] }))
		await sync()
		const before = readWorkRecords(dir).filter((row) => row.type === "request_cost" && row.requestId !== requestId)
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000)
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(4)
		// The saved report also lists connected works' requests on the same PR.
		expect(report(workId).requests.find((row: { requestId: string }) => row.requestId === requestId).totalCostUsd).toBe(
			"0.123456789",
		)
		expect(readWorkRecords(dir).filter((row) => row.type === "request_cost" && row.requestId !== requestId)).toEqual(
			before,
		)
	})
	it("keeps one cached failed account verification out of every journal and retries on schedule", async () => {
		const works = Array.from({ length: 35 }, (_, i) => tagged(`session-${i}`).workId)
		fetchMock.mockImplementation(async () => new Response(null, { status: 503 }))
		await sync()
		expect(fetchMock).toHaveBeenCalledOnce()
		expect(readWorkRecords(dir).filter((row) => row.type === "request_cost")).toEqual([])
		for (const workId of works)
			expect(report(workId).requests[0].billingLookup).toMatchObject({
				status: "unavailable",
				reason: "Billing API returned HTTP 503",
			})
		await sync()
		expect(fetchMock).toHaveBeenCalledOnce()
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30_000)
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})
	it("bounds appended rows per pass and visits the remaining requests on the next pass", async () => {
		for (let i = 0; i < 35; i++) tagged(`session-${i}`)
		currentKey = "test-only-new-account"
		await sync()
		expect(fetchMock).not.toHaveBeenCalled()
		expect(readWorkRecords(dir).filter((row) => row.type === "request_cost")).toHaveLength(30)
		await sync()
		expect(readWorkRecords(dir).filter((row) => row.type === "request_cost")).toHaveLength(35)
	})
	it("enforces the wall deadline before another HTTP call even before the timer fires", async () => {
		const { workId, requestId } = tagged("a")
		tagged("b")
		const now = Date.now()
		vi.spyOn(Date, "now").mockReturnValue(now)
		fetchMock.mockImplementation(async () => {
			vi.mocked(Date.now).mockReturnValue(now + 5001)
			return Response.json({ organizationId: ORG, userId: PROMPT })
		})
		await sync()
		expect(fetchMock).toHaveBeenCalledOnce()
		// The key check succeeded, but no billing page arrived: nothing is journaled.
		expect(readWorkRecords(dir).filter((row) => row.type === "request_cost")).toEqual([])
		// The saved report also lists the connected work's request on the same PR.
		expect(report(workId).requests.find((row: { requestId: string }) => row.requestId === requestId)).toMatchObject({
			priceStatus: "missing",
			totalCostUsd: null,
			billingLookup: {
				status: "unavailable",
				reason: "Billing lookup time limit exceeded before receiving any billing page",
			},
		})
	})
	it("keeps a known price when an empty refresh exhausts the pass budget without claiming a fresh check", async () => {
		const { workId } = tagged()
		await sync()
		const original = readWorkRecords(dir).find((row) => row.type === "request_cost")
		let now = Date.now() + RECHECK_MS
		const refreshStarted = new Date(now).toISOString()
		vi.spyOn(Date, "now").mockImplementation(() => now)
		fetchMock.mockImplementationOnce(async () => {
			now += 5001
			return Response.json({ organizationId: ORG, userId: PROMPT })
		})
		await sync()
		const observations = readWorkRecords(dir).filter((row) => row.type === "request_cost")
		expect(observations).toEqual([original])
		expect(report(workId).requests[0]).toMatchObject({
			priceStatus: "priced",
			totalCostUsd: "0.123456789",
			billingLookup: {
				status: "unavailable",
				checkedAt: refreshStarted,
				organizationId: ORG,
				userId: PROMPT,
				reason: "Billing lookup time limit exceeded before receiving any billing page",
			},
		})
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.123456789")
		expect(workCostDetails(dir, workId)).toContain(
			"Last billing refresh failed for 1 request: Billing lookup time limit exceeded before receiving any billing page.",
		)
		fetchMock.mockClear()
		await sync()
		expect(fetchMock).not.toHaveBeenCalled()
		expect(readWorkRecords(dir).filter((row) => row.type === "request_cost")).toEqual(observations)
		// No evidence arrived, so the known price keeps its own refresh schedule.
		now += RECHECK_MS
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(readWorkRecords(dir).filter((row) => row.type === "request_cost")).toEqual(observations)
		expect(report(workId).requests[0].billingLookup).toEqual(original?.billingLookup)
		expect(workCostDetails(dir, workId).join("\n")).not.toContain("Last billing refresh failed")
	})
	it("keeps a legacy timeout unknown through a new empty timeout until a complete lookup succeeds", async () => {
		const { workId, requestId, ctx, source, selector } = tagged()
		await sync()
		let now = Date.now() + 6 * 60_000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		appendWorkRecord(ctx, {
			type: "request_cost",
			requestId,
			billingSource: source,
			billingSelector: selector,
			billingRows: [],
			billingLookup: {
				status: "unavailable",
				checkedAt: new Date(now).toISOString(),
				organizationId: ORG,
				reason: "Billing lookup time limit exceeded",
			},
		})
		fetchMock.mockClear()
		await sync()
		expect(fetchMock).not.toHaveBeenCalled()
		expect(report(workId).requests[0]).toMatchObject({
			priceStatus: "missing",
			knownCostUsd: "0.123456789",
			totalCostUsd: null,
		})
		now += 30_000
		const refreshStarted = new Date(now).toISOString()
		fetchMock.mockImplementationOnce(async () => {
			now += 5001
			return Response.json({ organizationId: ORG, userId: PROMPT })
		})
		await sync()
		expect(report(workId).requests[0]).toMatchObject({
			priceStatus: "missing",
			totalCostUsd: null,
			billingLookup: {
				status: "unavailable",
				checkedAt: refreshStarted,
				reason: "Billing lookup time limit exceeded before receiving any billing page",
			},
		})
		now += 30_000
		await sync()
		expect(report(workId).requests[0]).toMatchObject({
			priceStatus: "priced",
			totalCostUsd: "0.123456789",
			billingLookup: { status: "priced", checkedAt: new Date(now).toISOString() },
		})
	})
	it("keeps a partial refresh incomplete when the next page exhausts the pass budget", async () => {
		const { workId } = tagged()
		await sync()
		let now = Date.now() + RECHECK_MS
		vi.spyOn(Date, "now").mockImplementation(() => now)
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockImplementationOnce(async () => {
			now += 5001
			return Response.json({
				items: [{ id: "44444444-2222-4333-8444-555555555555", totalPrice: "0.2" }],
				nextPageCursor: "unfinished",
			})
		})
		await sync()
		expect(report(workId).requests[0]).toMatchObject({
			priceStatus: "missing",
			knownCostUsd: "0.323456789",
			totalCostUsd: null,
			billingLookup: { status: "unavailable", reason: "Billing lookup time limit exceeded during pagination" },
		})
	})
	it("keeps an empty page incomplete when its continuation exhausts the pass budget", async () => {
		const { workId } = tagged()
		await sync()
		let now = Date.now() + RECHECK_MS
		const refreshStarted = new Date(now).toISOString()
		vi.spyOn(Date, "now").mockImplementation(() => now)
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockImplementationOnce(async () => {
			now += 5001
			return Response.json({ items: [], totalCount: 1, nextPageCursor: "next-page" })
		})
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(4)
		expect(report(workId).requests[0]).toMatchObject({
			priceStatus: "missing",
			knownCostUsd: "0.123456789",
			totalCostUsd: null,
		})
		expect(readWorkRecords(dir).filter((row) => row.type === "request_cost")[1]).toMatchObject({
			billingRows: [],
			billingLookup: {
				status: "unavailable",
				checkedAt: refreshStarted,
				reason: "Billing lookup time limit exceeded during pagination",
			},
		})
		now += 30_000
		fetchMock.mockImplementationOnce(async () => {
			now += 5001
			return Response.json({ organizationId: ORG, userId: PROMPT })
		})
		await sync()
		expect(report(workId).requests[0].billingLookup.reason).toBe(
			"Billing lookup time limit exceeded before receiving any billing page",
		)
		expect(report(workId).pullRequests[0].totalCostUsd).toBeNull()
	})
	it.each([
		["offline", new TypeError("fetch failed"), "Billing lookup unavailable"],
		[
			"DNS",
			new TypeError("fetch failed", {
				cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
			}),
			"Billing lookup unavailable",
		],
		[
			"TLS",
			new TypeError("fetch failed", { cause: Object.assign(new Error("certificate"), { code: "CERT_HAS_EXPIRED" }) }),
			"Billing lookup unavailable",
		],
		["key check", new Response(null, { status: 401 }), "Billing API returned HTTP 401"],
		["rate limit", new Response(null, { status: 429 }), "Billing API returned HTTP 429"],
		["server error", new Response(null, { status: 503 }), "Billing API returned HTTP 503"],
		["non-JSON page", new Response("<html>proxy</html>"), "Billing lookup unavailable"],
	] as const)("keeps a known price without a journal row after a %s failure before the first page", async (kind, failure, reason) => {
		const { workId } = tagged()
		await sync()
		const journal = readWorkRecords(dir)
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + RECHECK_MS)
		// A failed key check fails the first call; the others fail the first billing page.
		const reply = () => (failure instanceof Response ? Promise.resolve(failure) : Promise.reject(failure))
		if (kind === "offline" || kind === "DNS" || kind === "TLS" || kind === "key check")
			fetchMock.mockImplementationOnce(reply)
		else {
			fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
			fetchMock.mockImplementationOnce(reply)
		}
		await sync()
		expect(readWorkRecords(dir)).toEqual(journal)
		expect(report(workId).requests[0]).toMatchObject({
			priceStatus: "priced",
			totalCostUsd: "0.123456789",
			billingLookup: { status: "unavailable", reason },
		})
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.123456789")
		expect(workCostDetails(dir, workId)).toContain(`Last billing refresh failed for 1 request: ${reason}.`)
	})
	it.each([
		"owner",
		"malformed",
		"empty",
		"conflicting",
	])("does not revive an old price after %s evidence followed by an empty budget timeout", async (failure) => {
		const { workId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		await sync()
		let now = Date.now() + RECHECK_MS
		vi.spyOn(Date, "now").mockImplementation(() => now)
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		const item = {
			id: ROW,
			totalPrice: failure === "malformed" ? "NaN" : "0.5",
			castaiApiKeyOwnerId: failure === "owner" ? ROW : PROMPT,
		}
		fetchMock.mockResolvedValueOnce(Response.json({ items: failure === "empty" ? [] : [item] }))
		await sync()
		expect(report(workId).pullRequests[0].totalCostUsd).toBeNull()
		now += RECHECK_MS
		fetchMock.mockImplementationOnce(async () => {
			now += 5001
			return Response.json({ organizationId: ORG, userId: PROMPT })
		})
		await sync()
		expect(report(workId).requests[0].billingLookup).toMatchObject({
			status: "unavailable",
			reason: "Billing lookup time limit exceeded before receiving any billing page",
		})
		expect(report(workId).pullRequests[0].totalCostUsd).toBeNull()
	})
	it.each([2, -1, 1.5, "2"])("keeps an incomplete or invalid reported count (%s) unknown", async (totalCount) => {
		const { workId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(Response.json({ items: [{ id: ROW, totalPrice: "1.25" }], totalCount }))
		await sync()
		expect(report(workId).pullRequests[0].totalCostUsd).toBeNull()
	})
	it("rejects response metadata owned by another work or session", async () => {
		const { workId, source, requestId } = tagged()
		const other = createContext({ cwd: dir, sessionManager: { getSessionId: () => "unrelated-session" } })
		appendWorkRecord(other, {
			type: "request_response",
			requestId,
			billingSource: source,
			response: { promptId: PROMPT },
		})
		await sync()
		expect(fetchMock).not.toHaveBeenCalled()
		expect(report(workId).pullRequests[0].totalCostUsd).toBeNull()
	})
	it("accepts a later valid price after a malformed decimal without preserving the rejected amount", async () => {
		const { workId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(Response.json({ items: [{ id: ROW, totalPrice: "NaN" }] }))
		await sync()
		expect(report(workId).pullRequests[0].totalCostUsd).toBeNull()
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000)
		await sync()
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.123456789")
		expect(JSON.stringify(readWorkRecords(dir))).not.toContain("NaN")
	})
	it("recovers exact prices into a damaged work summary from the source ledger", async () => {
		const { workId } = tagged()
		await sync()
		await flushWorkSummaries()
		const before = savedWorkSummary(dir, workId)
		writeFileSync(join(dir, "work", workId, "work.json"), "broken")
		recoverWorkSummaries()
		await flushWorkSummaries()
		expect(savedWorkSummary(dir, workId)).toEqual(before)
	})
	it("bounds requests per pass and visits the remaining requests on the next pass", async () => {
		for (let i = 0; i < 35; i++) tagged(`session-${i}`)
		fetchMock.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: ORG, userId: PROMPT })
				: Response.json({ items: [] }),
		)
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(30)
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(37)
		expect(
			new Set(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("tags")).filter(Boolean))
				.size,
		).toBe(35)
	})
	it("aborts a stalled response body and cancels its reader", async () => {
		tagged()
		const controller = new AbortController()
		const cancel = vi.fn()
		fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
		const running = reconcileWorkCosts(dir, controller.signal)
		const rejected = expect(running).rejects.toThrow()
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
		controller.abort()
		await rejected
		expect(cancel).toHaveBeenCalledOnce()
	})
	it("does not grow the ledger for unchanged requests that have no billing identity", async () => {
		const ctx = createContext({ cwd: dir })
		const workId = getWorkId(ctx)
		appendWorkRecord(ctx, { type: "request", requestId: "old-gateway" })
		appendWorkRecord(ctx, { type: "request_response", requestId: "old-gateway", response: { status: 200 } })
		const before = readWorkRecords(dir)
		await sync()
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000)
		await sync()
		expect(readWorkRecords(dir)).toEqual(before)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(report(workId).requests[0].totalCostUsd).toBeNull()
	})
	it("rebuilds a missing derived report from durable cost observations without refetching", async () => {
		const { workId } = tagged()
		await sync()
		const before = report(workId)
		unlinkSync(join(dir, "work", workId, "costs.json"))
		fetchMock.mockClear()
		await sync()
		expect(report(workId)).toEqual(before)
		expect(fetchMock).not.toHaveBeenCalled()
	})
	it("does not let a malformed cost observation claim a complete total", async () => {
		const { ctx, workId, source, requestId, selector } = tagged()
		appendWorkRecord(ctx, {
			type: "request_cost",
			requestId,
			billingSource: source,
			billingSelector: selector,
			billingRows: [{ id: ROW, costUsd: "100" }],
			billingLookup: { status: "priced", checkedAt: new Date().toISOString() },
		})
		await sync()
		expect(report(workId).pullRequests[0].totalCostUsd).toBeNull()
	})
	it("remembers the original verified organization across failed or changed-account refreshes", async () => {
		const { workId } = tagged()
		await sync()
		const now = Date.now()
		vi.spyOn(Date, "now").mockReturnValue(now + RECHECK_MS)
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: "44444444-2222-4333-8444-555555555555" }))
		await sync()
		vi.mocked(Date.now).mockReturnValue(now + RECHECK_MS + 60_000)
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: "44444444-2222-4333-8444-555555555555" }))
		await sync()
		expect(report(workId).requests[0].billingLookup).toMatchObject({
			status: "account-changed",
			organizationId: ORG,
			reason: "Original billing organization changed",
		})
		// The bill verified under the original organization still counts.
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.123456789")
		expect(readWorkRecords(dir).filter((row) => row.type === "request_cost")).toHaveLength(2)
		expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("llm-requests"))).toHaveLength(1)
	})
	it("keeps a verified price through a key change while unpriced requests stay unknown", async () => {
		const priced = tagged("priced")
		const pending = tagged("pending")
		fetchMock.mockImplementation(async (input) => {
			const tag = new URL(String(input)).searchParams.get("tags")
			if (!tag) return Response.json({ organizationId: ORG, userId: PROMPT })
			return Response.json({
				items: tag === `kimchi-request:${priced.requestId}` ? [{ id: ROW, totalPrice: "0.2" }] : [],
			})
		})
		await sync()
		currentKey = "test-only-rotated-key"
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + RECHECK_MS)
		fetchMock.mockClear()
		await sync()
		expect(fetchMock).not.toHaveBeenCalled()
		// Both works share the PR, so each saved report lists both requests.
		const saved = (workId: string, requestId: string) =>
			report(workId).requests.find((row: { requestId: string }) => row.requestId === requestId)
		expect(saved(priced.workId, priced.requestId)).toMatchObject({
			priceStatus: "priced",
			totalCostUsd: "0.200000000",
			billingLookup: { status: "account-changed", reason: "Original credential or endpoint is no longer configured" },
		})
		expect(saved(pending.workId, pending.requestId)).toMatchObject({
			priceStatus: "missing",
			totalCostUsd: null,
			billingLookup: { status: "account-changed" },
		})
		// Once the original key is back, the verified request is refreshed again.
		currentKey = "test-only-original-key"
		vi.mocked(Date.now).mockReturnValue(Date.now() + 6 * 60_000)
		await sync()
		expect(saved(priced.workId, priced.requestId).billingLookup.status).toBe("priced")
	})
	it("does not grow the journal for a verified price whose account changed after the window", async () => {
		const { workId } = tagged()
		await sync()
		let now = Date.parse("2026-11-02T08:00:00.000Z") + 60_000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		fetchMock.mockImplementation(async () => Response.json({ organizationId: ORG, userId: ROW }))
		for (let hour = 0; hour < 5; hour++) {
			await sync()
			now += 60 * 60_000
		}
		const rows = readWorkRecords(dir).filter((row) => row.type === "request_cost")
		expect(rows).toHaveLength(2)
		expect(rows[1].billingLookup).toMatchObject({
			status: "account-changed",
			reason: "Original billing API key owner changed",
		})
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.123456789")
		expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("llm-requests"))).toHaveLength(1)
	})
	it("bounds looping pages and keeps the known subtotal unknown", async () => {
		const { workId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockImplementation(async () =>
			Response.json({ items: [{ id: ROW, totalPrice: "1" }], nextPageCursor: "same-page" }),
		)
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(report(workId).pullRequests[0]).toMatchObject({ knownCostUsd: "1.000000000", totalCostUsd: null })
	})
	it("stops at the page limit and keeps the known subtotal unknown", async () => {
		const { workId } = tagged()
		let page = 0
		fetchMock.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: ORG, userId: PROMPT })
				: Response.json({
						items: [{ id: `44444444-2222-4333-8444-55555555555${page}`, totalPrice: "1" }],
						nextPageCursor: `page-${++page}`,
					}),
		)
		await sync()
		// One key check and five pages; the sixth page is never requested.
		expect(fetchMock).toHaveBeenCalledTimes(6)
		expect(report(workId).requests[0].billingLookup).toMatchObject({
			status: "unavailable",
			reason: "Billing lookup exceeded the page limit",
		})
		expect(report(workId).pullRequests[0]).toMatchObject({ knownCostUsd: "5.000000000", totalCostUsd: null })
	})
	it("bounds oversized responses without persisting any response contents", async () => {
		const { workId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(new Response("x".repeat(1_048_577)))
		await sync()
		expect(report(workId).pullRequests[0].totalCostUsd).toBeNull()
		expect(JSON.stringify(readWorkRecords(dir)).length).toBeLessThan(10_000)
	})
	it("pins only configured gateway and API identity without persisting a credential", () => {
		const source = captureBillingSource(new Headers({ Authorization: `Bearer ${currentKey}` }), GATEWAY, dir)
		expect(source).toMatchObject({
			apiUrl: API,
			gatewayUrl: GATEWAY,
			credentialHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		})
		expect(JSON.stringify(source)).not.toContain(currentKey)
		expect(
			captureBillingSource(
				new Headers({ Authorization: `Bearer ${currentKey}` }),
				"https://unrelated.example/v1/chat/completions",
				dir,
			),
		).toBeUndefined()
		expect(captureBillingSource(new Headers(), GATEWAY, dir)).toBeUndefined()
		expect(
			captureBillingSource(new Headers({ Authorization: `Bearer ${currentKey}` }), `${GATEWAY}?key=private`, dir),
		).toEqual(source)
	})
	it("looks up the exact tag under the verified organization and persists decimal prices", async () => {
		const { workId, requestId } = tagged()
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(2)
		const lookup = new URL(String(fetchMock.mock.calls[1][0]))
		expect(lookup.pathname).toBe(`/api/ai-optimizer/v1beta/organizations/${ORG}/llm-requests`)
		expect(Object.fromEntries(lookup.searchParams)).toEqual({
			tags: `kimchi-request:${requestId}`,
			startTime: "2026-09-30T20:00:00.000Z",
			endTime: "2026-11-02T08:00:00.000Z",
			inferUserFromApiKey: "true",
			"page.limit": "100",
		})
		expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("Authorization")).toBe(`Bearer ${currentKey}`)
		expect(fetchMock.mock.calls[1][1]?.body).toBeUndefined()
		expect(report(workId).pullRequests[0]).toMatchObject({ knownCostUsd: "0.123456789", totalCostUsd: "0.123456789" })
		await flushWorkSummaries()
		const summary = savedWorkSummary(dir, workId)
		expect(summary.requests).toHaveLength(1)
		expect(summary.requests[0].billingRows).toEqual([{ id: ROW, costUsd: "0.123456789" }])
		expect(JSON.stringify(readWorkRecords(dir))).not.toContain(currentKey)
		expect(workCostDetails(dir, workId).join("\n")).toContain("$0.123456789")
	})
	it("allocates a PR across two works and counts repeated sync only once", async () => {
		const first = tagged("planning")
		const second = tagged("implementation")
		fetchMock.mockImplementation(async (input) => {
			const url = new URL(String(input))
			if (url.pathname.endsWith("api-keys:verify")) return Response.json({ organizationId: ORG, userId: PROMPT })
			const planned = url.searchParams.get("tags") === `kimchi-request:${first.requestId}`
			return Response.json({
				items: [{ id: planned ? ROW : "55555555-2222-4333-8444-555555555555", totalPrice: "0.000000001" }],
			})
		})
		await sync()
		await sync()
		for (const { workId } of [first, second])
			expect(report(workId).pullRequests[0]).toMatchObject({
				totalCostUsd: "0.000000002",
				requestIds: [first.requestId, second.requestId].sort(),
			})
	})
	it("follows all pages, deduplicates repeated billing rows, and sums distinct rows", async () => {
		const { workId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(
			Response.json({ items: [{ id: ROW, totalPrice: "1.000000001" }], nextPageCursor: "page two" }),
		)
		fetchMock.mockResolvedValueOnce(
			Response.json({
				items: [
					{ id: ROW, totalPrice: "1.000000001" },
					{ id: "44444444-2222-4333-8444-555555555555", totalPrice: "2.000000002" },
				],
			}),
		)
		await sync()
		expect(new URL(String(fetchMock.mock.calls[2][0])).searchParams.get("page.cursor")).toBe("page two")
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("3.000000003")
	})
	it.each([401, 403, 404, 422, 503])("keeps HTTP %s lookups unknown and exposes the reason locally", async (status) => {
		const { workId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(new Response("unavailable", { status }))
		await sync()
		expect(report(workId).pullRequests[0]).toMatchObject({ knownCostUsd: "0.000000000", totalCostUsd: null })
		expect(workCostDetails(dir, workId).join("\n")).toContain("unknown")
	})
	it.each([
		{ id: "invalid", totalPrice: "1" },
		{ id: ROW, totalPrice: 1.5 },
		{ id: ROW, totalPrice: "NaN" },
		{ id: ROW, totalPrice: "0.0000000001" },
	])("rejects malformed billing evidence: %j", async (item) => {
		const { workId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(Response.json({ items: [item] }))
		await sync()
		expect(report(workId).pullRequests[0].totalCostUsd).toBeNull()
	})
	it("keeps missing billing pending and accepts a late explicit zero", async () => {
		const { workId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(Response.json({ items: [] }))
		await sync()
		expect(report(workId).pullRequests[0].totalCostUsd).toBeNull()
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000)
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(Response.json({ items: [{ id: ROW, totalPrice: "0" }] }))
		await sync()
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.000000000")
	})
	it("never queries another key for an old request", async () => {
		const { workId } = tagged()
		currentKey = "test-only-another-account"
		await sync()
		expect(fetchMock).not.toHaveBeenCalled()
		expect(report(workId).requests[0].billingLookup.status).toBe("account-changed")
		expect(report(workId).pullRequests[0].totalCostUsd).toBeNull()
	})
	it("keeps known rows as a subtotal when pagination stops early", async () => {
		const { workId } = tagged()
		fetchMock.mockResolvedValueOnce(Response.json({ organizationId: ORG, userId: PROMPT }))
		fetchMock.mockResolvedValueOnce(Response.json({ items: [{ id: ROW, totalPrice: "1.25" }], nextPageCursor: "more" }))
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
		await sync()
		expect(report(workId).pullRequests[0]).toMatchObject({ knownCostUsd: "1.250000000", totalCostUsd: null })
	})
	it("aborts an in-flight lookup without publishing a completed result", async () => {
		const { workId } = tagged()
		const controller = new AbortController()
		fetchMock.mockImplementation(
			async (_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
				}),
		)
		const running = reconcileWorkCosts(dir, controller.signal)
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
		controller.abort()
		await expect(running).rejects.toThrow()
		expect(readWorkRecords(dir).filter((row) => row.type === "request_cost")).toEqual([])
		expect(() => report(workId)).toThrow()
	})
	it("stops reading the journals once aborted instead of finishing the calculation", async () => {
		tagged()
		const calculate = vi.spyOn(costs, "calculatePullRequestCosts")
		const controller = new AbortController()
		const running = reconcileWorkCosts(dir, controller.signal)
		// Closing a session aborts the pass while the journals are still being read.
		controller.abort()
		await expect(running).rejects.toThrow(expect.objectContaining({ name: "AbortError" }))
		expect(calculate).not.toHaveBeenCalled()
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe("billing refresh after the request tag window closes", () => {
	function taggedRequest() {
		const ctx = createContext({ cwd: dir, sessionManager: { getSessionId: () => "session" } })
		getWorkId(ctx)
		const requestId = randomUUID()
		const dispatchedAt = "2026-10-01T08:00:00.000Z"
		appendWorkRecord(ctx, {
			type: "request",
			requestId,
			startedAt: dispatchedAt,
			scope: { account: { apiUrl: API, organizationId: ORG, userId: PROMPT }, repository: join(dir, ".git") },
		})
		appendWorkRecord(ctx, {
			type: "request_dispatch",
			requestId,
			dispatchedAt,
			billingSource: captureBillingSource(new Headers({ Authorization: `Bearer ${currentKey}` }), GATEWAY, dir),
			billingSelector: requestTagSelector(requestId, dispatchedAt),
		})
	}
	const ledgerBytes = () =>
		readdirSync(join(dir, "work-attribution"))
			.filter((name) => name.endsWith(".jsonl"))
			.reduce((sum, name) => sum + statSync(join(dir, "work-attribution", name)).size, 0)
	const costRows = () => readWorkRecords(dir).filter((row) => row.type === "request_cost")
	const billingCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("llm-requests")).length

	it("stops re-querying and re-recording a never-billed attempt once no bill can still arrive", async () => {
		taggedRequest()
		fetchMock.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: ORG, userId: PROMPT })
				: Response.json({ items: [] }),
		)
		// 50 days after dispatch, past the selector's fixed 32-day end time.
		let now = Date.parse("2026-11-20T00:00:00.000Z")
		vi.spyOn(Date, "now").mockImplementation(() => now)
		const before = ledgerBytes()
		for (let pass = 0; pass < 20; pass++) {
			await reconcileWorkCosts(dir, new AbortController().signal)
			now += 31_000
		}
		expect(billingCalls()).toBeLessThanOrEqual(1)
		expect(costRows().length).toBeLessThanOrEqual(1)
		expect(ledgerBytes() - before).toBeLessThan(2000)
		expect(readWorkCostReport(dir).report.requests[0].totalCostUsd).toBe("0.000000000")
	})
	it("does not re-record an unchanged known price on every refresh", async () => {
		taggedRequest()
		fetchMock.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: ORG, userId: PROMPT })
				: Response.json({ items: [{ id: ROW, totalPrice: "0.000166000" }] }),
		)
		let now = Date.parse("2026-11-20T00:00:00.000Z")
		vi.spyOn(Date, "now").mockImplementation(() => now)
		for (let pass = 0; pass < 12; pass++) {
			await reconcileWorkCosts(dir, new AbortController().signal)
			now += 5 * 60_000 + 1000
		}
		expect(costRows()).toHaveLength(1)
	})
	it("drops a request's poll entry once its final check is journaled, then never calls for it again", async () => {
		const { workId, requestId } = tagged()
		await sync()
		const polls = () => JSON.parse(readFileSync(join(dir, "work-attribution", "billing-polls.json"), "utf8"))
		expect(polls()).toHaveProperty(requestId)
		let now = Date.parse("2026-11-02T08:00:00.000Z") + 60_000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		fetchMock.mockClear()
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(2)
		// The unchanged final result is journaled once, so the journal proves that the window closed.
		expect(costRows()).toHaveLength(2)
		expect(costRows()[1].billingLookup).toMatchObject({ status: "priced", checkedAt: new Date(now).toISOString() })
		expect(polls()).not.toHaveProperty(requestId)
		now += 3 * 24 * 60 * 60_000
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(costRows()).toHaveLength(2)
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.123456789")
	})
	it.each([
		["a late launch with another key", "key"],
		["an API key owner change before the window ended", "owner"],
	])("keeps an unpriced request open after %s until the original account returns", async (_name, change) => {
		const { workId } = tagged()
		fetchMock.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: ORG, userId: PROMPT })
				: Response.json({ items: [] }),
		)
		await sync()
		// The tag window ends 32 days after the 08:00 dispatch.
		const end = Date.parse("2026-11-02T08:00:00.000Z")
		let now = change === "key" ? end + 60_000 : end - 60 * 60_000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		if (change === "key") currentKey = "test-only-rotated-key"
		else fetchMock.mockImplementation(async () => Response.json({ organizationId: ORG, userId: ROW }))
		for (let pass = 0; pass < 4; pass++) {
			await sync()
			now += 60 * 60_000 + 1000
		}
		// These lookups never reached the billing API, so none of them closes the window.
		expect(costRows()).toMatchObject([
			{ billingLookup: { status: "pending" } },
			{ billingLookup: { status: "account-changed" } },
		])
		currentKey = "test-only-original-key"
		fetchMock.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: ORG, userId: PROMPT })
				: Response.json({ items: [{ id: ROW, totalPrice: "0.123456789" }] }),
		)
		await sync()
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.123456789")
	})
	it("drops poll entries of requests that no journal contains", async () => {
		const { requestId } = tagged()
		await sync()
		const path = join(dir, "work-attribution", "billing-polls.json")
		const stray = randomUUID()
		const saved = JSON.parse(readFileSync(path, "utf8"))
		writeFileSync(path, JSON.stringify({ ...saved, [stray]: { checkedAt: Date.now(), lookupAt: "" } }))
		await sync()
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual([requestId])
	})
	it("retries a final check made offline and keeps the known total until it succeeds", async () => {
		const { workId } = tagged()
		await sync()
		const journal = readWorkRecords(dir)
		// The tag window ends 32 days after the 08:00 dispatch.
		const end = Date.parse("2026-11-02T08:00:00.000Z")
		let now = end + 60_000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		let online = false
		fetchMock.mockReset()
		fetchMock.mockImplementation(async (input) => {
			if (!online) throw new TypeError("fetch failed")
			return String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: ORG, userId: PROMPT })
				: Response.json({ items: [{ id: ROW, totalPrice: "0.123456789" }] })
		})
		await sync()
		expect(fetchMock).toHaveBeenCalledOnce()
		expect(readWorkRecords(dir)).toEqual(journal)
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.123456789")
		// A failed final check is retried on the slow schedule, not on every pass.
		now += 30 * 60_000
		await sync()
		expect(fetchMock).toHaveBeenCalledOnce()
		online = true
		now += 30 * 60_000
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(costRows().at(-1)?.billingLookup).toMatchObject({ status: "priced", checkedAt: new Date(now).toISOString() })
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.123456789")
		expect(workCostDetails(dir, workId).join("\n")).not.toContain("Last billing refresh failed")
		// The journal now proves that the window closed.
		now += 2 * 24 * 60 * 60_000
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(costRows()).toHaveLength(2)
	})
	it("keeps an offline period out of the journal for every priced request in the window", async () => {
		const works = [tagged("first").workId, tagged("second").workId, tagged("third").workId]
		const bills = new Map<string, string>()
		let online = true
		fetchMock.mockImplementation(async (input) => {
			if (!online) throw new TypeError("fetch failed")
			const tag = new URL(String(input)).searchParams.get("tags")
			if (!tag) return Response.json({ organizationId: ORG, userId: PROMPT })
			const id = bills.get(tag) ?? randomUUID()
			bills.set(tag, id)
			return Response.json({ items: [{ id, totalPrice: "0.123456789" }] })
		})
		await sync()
		const journal = readWorkRecords(dir)
		// The three works contribute to one PR.
		expect(report(works[0]).pullRequests[0].totalCostUsd).toBe("0.370370367")
		let now = Date.now()
		vi.spyOn(Date, "now").mockImplementation(() => now)
		online = false
		for (let pass = 0; pass < 40; pass++) {
			if (pass === 20) online = true
			now += 60_000
			await sync()
			for (const workId of works) expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.370370367")
		}
		expect(fetchMock.mock.calls.length).toBeGreaterThan(6)
		expect(readWorkRecords(dir)).toEqual(journal)
	})
})

/**
 * Writes one session journal directly; appending through the extension would also rebuild
 * a work summary per row. Each request has a stable billing row, so repeated lookups are unchanged.
 */
function seedJournal(
	requests: { requestId: string; dispatchedAt: string; lookup?: "priced" | "pending"; checkedAt?: string }[],
) {
	const sessionId = randomUUID()
	const workId = randomUUID()
	const source = captureBillingSource(new Headers({ Authorization: `Bearer ${currentKey}` }), GATEWAY, dir)
	const base = { version: 1, sessionId, workId, cwd: dir }
	const lines = requests.flatMap(({ requestId, dispatchedAt, lookup, checkedAt }) => {
		const selector = requestTagSelector(requestId, dispatchedAt)
		const rows: Record<string, unknown>[] = [
			{ ...base, type: "request", requestId, startedAt: dispatchedAt, recordedAt: dispatchedAt },
			{
				...base,
				type: "request_dispatch",
				requestId,
				dispatchedAt,
				billingSource: source,
				billingSelector: selector,
				recordedAt: dispatchedAt,
			},
		]
		if (lookup)
			rows.push({
				...base,
				type: "request_cost",
				requestId,
				billingSource: source,
				billingSelector: selector,
				billingRows: lookup === "priced" ? [{ id: billingId(requestId), costUsd: "0.000100000" }] : [],
				billingLookup: { status: lookup, checkedAt, organizationId: ORG, userId: PROMPT },
				recordedAt: checkedAt,
			})
		return rows
	})
	mkdirSync(join(dir, "work-attribution"), { recursive: true })
	writeFileSync(
		join(dir, "work-attribution", `${sessionId}.jsonl`),
		`${lines.map((row) => JSON.stringify(row)).join("\n")}\n`,
	)
}
const billingIds = new Map<string, string>()
function billingId(requestId: string): string {
	const id = billingIds.get(requestId) ?? randomUUID()
	billingIds.set(requestId, id)
	return id
}
const lookedUp = () =>
	fetchMock.mock.calls.flatMap(([input]) => {
		const tag = new URL(String(input)).searchParams.get("tags")
		return tag ? [tag.slice("kimchi-request:".length)] : []
	})

describe("billing poll scheduling", () => {
	beforeEach(() => {
		fetchMock.mockImplementation(async (input) => {
			const tag = new URL(String(input)).searchParams.get("tags")
			if (!tag) return Response.json({ organizationId: ORG, userId: PROMPT })
			const requestId = tag.slice("kimchi-request:".length)
			return Response.json({ items: [{ id: billingId(requestId), totalPrice: "0.000100000" }] })
		})
	})
	it("looks up a due pending price before rechecking 1,000 known prices", async () => {
		const now = Date.parse("2026-10-08T12:00:00.000Z")
		vi.setSystemTime(now)
		const pending = randomUUID()
		seedJournal([
			...Array.from({ length: 1000 }, () => ({
				requestId: randomUUID(),
				dispatchedAt: "2026-10-08T10:00:00.000Z",
				lookup: "priced" as const,
				checkedAt: new Date(now - 10 * 60_000).toISOString(),
			})),
			{
				requestId: pending,
				dispatchedAt: new Date(now - 40_000).toISOString(),
				lookup: "pending",
				checkedAt: new Date(now - 31_000).toISOString(),
			},
		])
		await sync()
		expect(fetchMock).toHaveBeenCalledTimes(30)
		expect(lookedUp()[0]).toBe(pending)
		expect(readWorkCostReport(dir).requests.get(pending)?.lookup?.status).toBe("priced")
	})
	it("rechecks 300 known prices older than a day at most once an hour", async () => {
		let now = Date.parse("2026-10-08T12:00:00.000Z")
		vi.setSystemTime(now)
		seedJournal(
			Array.from({ length: 300 }, () => ({
				requestId: randomUUID(),
				dispatchedAt: "2026-10-07T10:00:00.000Z",
				lookup: "priced" as const,
				checkedAt: new Date(now - 6 * 60 * 60_000).toISOString(),
			})),
		)
		const journal = readWorkRecords(dir)
		for (let pass = 0; pass < 120; pass++) {
			await sync()
			now += 30_000
			vi.setSystemTime(now)
		}
		// Each request is checked once in the hour: 300 lookups plus one key check per busy pass.
		expect(lookedUp()).toHaveLength(300)
		expect(new Set(lookedUp()).size).toBe(300)
		expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(300 + Math.ceil(300 / 29))
		expect(readWorkRecords(dir)).toEqual(journal)
	})
	it("rechecks a lasting failure older than a day every five minutes, not on every pass", async () => {
		let now = Date.parse("2026-10-08T12:00:00.000Z")
		vi.setSystemTime(now)
		const requestId = randomUUID()
		seedJournal([{ requestId, dispatchedAt: "2026-10-05T12:00:00.000Z" }])
		// A page arrives but its counted row never does, so every lookup fails after the first page.
		fetchMock.mockImplementation(async (input) =>
			new URL(String(input)).searchParams.get("tags")
				? Response.json({ items: [], totalCount: 1 })
				: Response.json({ organizationId: ORG, userId: PROMPT }),
		)
		for (let pass = 0; pass < 120; pass++) {
			await sync()
			now += 30_000
			vi.setSystemTime(now)
		}
		expect(lookedUp()).toHaveLength(12)
		expect(readWorkCostReport(dir).requests.get(requestId)?.lookup).toMatchObject({
			status: "unavailable",
			reason: "Billing response did not include every counted row",
		})
	})
	it("keeps the final check at the end of the window for a priced request on a daily recheck", async () => {
		const requestId = randomUUID()
		// Dispatched 31.5 days ago and last checked 12 hours ago: the next daily recheck would fall after the window.
		const dispatchedAt = "2026-09-01T00:00:00.000Z"
		const end = Date.parse("2026-10-03T00:00:00.000Z")
		vi.setSystemTime(end - 60_000)
		seedJournal([
			{ requestId, dispatchedAt, lookup: "priced", checkedAt: new Date(end - 12 * 60 * 60_000).toISOString() },
		])
		await sync()
		expect(fetchMock).not.toHaveBeenCalled()
		vi.setSystemTime(end + 60_000)
		await sync()
		expect(lookedUp()).toEqual([requestId])
		expect(readWorkCostReport(dir).requests.get(requestId)?.substantiveLookup?.checkedAt).toBe(
			new Date(end + 60_000).toISOString(),
		)
	})
})

describe("idle cost passes", () => {
	it("skips reading, recalculating and writing costs while the journals are unchanged", async () => {
		const { workId, ctx, requestId, source } = tagged()
		await sync()
		await flushWorkSummaries()
		const saved = report(workId)
		const read = vi.spyOn(summary, "readWorkRecordsAsync")
		const calculate = vi.spyOn(costs, "calculatePullRequestCosts")
		const write = vi.spyOn(json, "writeFileDurably")
		const readFile = vi.spyOn(fs, "readFileSync")
		const reports = (calls: unknown[][]) => calls.filter(([path]) => String(path).endsWith("costs.json"))
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000)
		await sync()
		await sync()
		expect(read).not.toHaveBeenCalled()
		expect(calculate).not.toHaveBeenCalled()
		expect(reports(write.mock.calls)).toEqual([])
		expect(reports(readFile.mock.calls)).toEqual([])
		expect(fetchMock).toHaveBeenCalledTimes(2)
		// A deleted report is rebuilt from the same calculation.
		unlinkSync(join(dir, "work", workId, "costs.json"))
		await sync()
		expect(report(workId)).toEqual(saved)
		expect(calculate).not.toHaveBeenCalled()
		expect(reports(write.mock.calls)).toHaveLength(1)
		// Any append changes the journals' fingerprint.
		appendWorkRecord(ctx, { type: "request_response", requestId, billingSource: source, response: { status: 200 } })
		await sync()
		expect(read).toHaveBeenCalledOnce()
		expect(calculate).toHaveBeenCalledOnce()
		expect(report(workId)).toEqual(saved)
	})
	it("keeps an idle pass over 5,000 settled requests far cheaper than recalculating them", async () => {
		seedJournal(
			Array.from({ length: 5000 }, () => ({
				requestId: randomUUID(),
				dispatchedAt: "2026-08-01T00:00:00.000Z",
				lookup: "priced" as const,
				checkedAt: "2026-09-10T00:00:00.000Z",
			})),
		)
		const timed = async () => {
			const started = performance.now()
			await sync()
			return performance.now() - started
		}
		const first = await timed()
		const idle = Math.min(await timed(), await timed())
		expect(fetchMock).not.toHaveBeenCalled()
		// A coarse ratio, not a wall-clock budget: both passes run on the same machine and load.
		expect(idle).toBeLessThan(first / 5)
	})
})

describe("empty billing settlement", () => {
	it("settles a complete empty lookup after 24 hours and accepts a later bill", async () => {
		const { workId, requestId } = tagged()
		const dispatchedAt = Date.parse("2026-10-01T08:00:00.000Z")
		let now = dispatchedAt + 23 * 60 * 60_000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		let billed = false
		fetchMock.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: ORG, userId: PROMPT })
				: Response.json({ items: billed ? [{ id: ROW, totalPrice: "0.012345678" }] : [] }),
		)
		await sync()
		expect(report(workId).requests[0].totalCostUsd).toBeNull()
		now = dispatchedAt + 24 * 60 * 60_000
		await sync()
		expect(report(workId).requests[0]).toMatchObject({ requestId, totalCostUsd: "0.000000000", billingRecordIds: [] })
		billed = true
		now += 24 * 60 * 60_000
		await sync()
		expect(report(workId).requests[0]).toMatchObject({ totalCostUsd: "0.012345678", billingRecordIds: [ROW] })
	})
	it("keeps a settled no-charge through a key change and after its window ends", async () => {
		const { workId } = tagged()
		const dispatchedAt = Date.parse("2026-10-01T08:00:00.000Z")
		let now = dispatchedAt + 25 * 60 * 60_000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		fetchMock.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: ORG, userId: PROMPT })
				: Response.json({ items: [] }),
		)
		await sync()
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.000000000")
		currentKey = "test-only-rotated-key"
		fetchMock.mockClear()
		now += 3 * 24 * 60 * 60_000
		await sync()
		expect(report(workId).requests[0]).toMatchObject({
			priceStatus: "priced",
			totalCostUsd: "0.000000000",
			billingLookup: { status: "account-changed" },
		})
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.000000000")
		// The changed key cannot close the window as unknown, and repeated passes add nothing.
		const journaled = readWorkRecords(dir).filter((row) => row.type === "request_cost").length
		now = dispatchedAt + 33 * 24 * 60 * 60_000
		for (let pass = 0; pass < 3; pass++) {
			await sync()
			now += 60 * 60_000
		}
		expect(fetchMock).not.toHaveBeenCalled()
		expect(readWorkRecords(dir).filter((row) => row.type === "request_cost")).toHaveLength(journaled)
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.000000000")
	})
	it.each(["incomplete", "error"])("does not settle a %s empty lookup", async (kind) => {
		const { workId } = tagged()
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-03T08:00:00.000Z"))
		fetchMock.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: ORG, userId: PROMPT })
				: kind === "incomplete"
					? Response.json({ items: [], totalCount: 1 })
					: new Response("unavailable", { status: 503 }),
		)
		await sync()
		expect(report(workId).requests[0].totalCostUsd).toBeNull()
	})
	it("keeps a request without a tag unpriced and never settles it as no-charge", async () => {
		// Two days old, with a captured prompt ID: the removed prompt-ID lookup settled this at a false $0.
		const requestId = randomUUID()
		const untagged = tracked("untagged", requestId, { startedAt: "2026-09-29T08:00:00Z" })
		appendWorkRecord(untagged.ctx, {
			type: "request_response",
			requestId,
			billingSource: untagged.source,
			response: { promptId: PROMPT },
		})
		const lookup = { status: "no-charge", checkedAt: "2026-10-01T11:30:00.000Z", organizationId: ORG, userId: PROMPT }
		appendWorkRecord(untagged.ctx, {
			type: "request_cost",
			requestId,
			billingSource: untagged.source,
			promptId: PROMPT,
			billingSelector: { type: "prompt", promptId: PROMPT },
			billingRows: [],
			billingLookup: lookup,
		})
		// Older ledgers saved prompt-ID results without a selector; a tagged request is looked up again.
		const control = tagged()
		appendWorkRecord(control.ctx, {
			type: "request_cost",
			requestId: control.requestId,
			billingSource: control.source,
			promptId: PROMPT,
			billingRows: [],
			billingLookup: lookup,
		})
		await sync()
		const lookups = fetchMock.mock.calls
			.map(([input]) => new URL(String(input)))
			.filter((url) => url.pathname.endsWith("/llm-requests"))
		expect(lookups.map((url) => url.searchParams.get("tags"))).toEqual([`kimchi-request:${control.requestId}`])
		const saved = (workId: string, id: string) =>
			report(workId).requests.find((row: { requestId: string }) => row.requestId === id)
		expect(saved(untagged.workId, requestId)).toMatchObject({
			totalCostUsd: null,
			billingLookup: { status: "pending" },
		})
		expect(report(untagged.workId).pullRequests[0].totalCostUsd).toBeNull()
		expect(saved(control.workId, control.requestId)).toMatchObject({ totalCostUsd: "0.123456789" })
	})
	it("keeps unchanged checks out of journals and preserves retry timing across reloads", async () => {
		const { workId } = tagged()
		let now = Date.parse("2026-10-02T08:00:00.000Z")
		vi.spyOn(Date, "now").mockImplementation(() => now)
		await sync()
		const before = readWorkRecords(dir).filter((row) => row.type === "request_cost")
		now += 2 * 60 * 60_000
		await sync()
		expect(readWorkRecords(dir).filter((row) => row.type === "request_cost")).toEqual(before)
		fetchMock.mockClear()
		vi.resetModules()
		const reloaded = await import("./cost-sync.js")
		await reloaded.reconcileWorkCosts(dir, new AbortController().signal)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(report(workId).pullRequests[0].totalCostUsd).toBe("0.123456789")
	})
})
