import * as fs from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import * as pullRequests from "../pull-request-status/pull-requests.js"
import * as health from "../telemetry/pr-cost.js"
import { readWorkCostReport, requestTagSelector } from "../work-attribution/cost-sync.js"
import { flushWorkSummaries } from "../work-attribution/summary.js"
import { appendWorkRecord } from "../work-attribution.js"
import { queueSnapshots, readReportingState, setReportingEnabled, UPLOAD_INTERVAL_MS } from "./queue.js"
import { buildSnapshots, type RepositorySnapshot, type WireSnapshot } from "./snapshot.js"
import { statusText } from "./status.js"
import { deliverSnapshots, LIMIT_RETRY_MS, reconcileReporting, serverLimit } from "./worker.js"

const config = vi.hoisted(() => ({ key: "test-key", endpoint: "https://api.example" }))
vi.mock("node:fs", async (original) => ({ ...(await original<typeof fs>()) }))
vi.mock("../../config.js", () => ({
	loadConfig: () => ({ apiKey: config.key }),
	resolveEndpoints: () => ({ platformApiUrl: config.endpoint }),
	readTelemetryConfig: () => ({ enabled: true }),
}))
const org = "11111111-1111-4111-8111-111111111111"
const user = "22222222-2222-4222-8222-222222222222"
const requestId = "33333333-3333-4333-8333-333333333333"
const content: RepositorySnapshot = {
	account: { apiUrl: "https://api.example", organizationId: org, userId: user },
	content: {
		repository: { provider: "github", host: "github.com", id: "42" },
		pullRequests: [],
		requests: [
			{
				requestId,
				billingRecordIds: [],
				startedAt: "2026-10-04T12:00:00Z",
				allocation: { kind: "unlinked", pullRequestIds: [], method: "native" },
			},
		],
		coverage: { observedRequests: 1, unpricedRequests: 1, historyComplete: true },
	},
}
let directory: string
const http = vi.fn<typeof fetch>()
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "kimchi-reporting-http-"))
	config.key = "test-key"
	config.endpoint = "https://api.example"
	http
		.mockReset()
		.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: Response.json({ status: "accepted", revision: "1", receivedAt: new Date().toISOString() }),
		)
	vi.stubGlobal("fetch", http)
	await setReportingEnabled(directory, true)
	await queueSnapshots(directory, [content])
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	await rm(directory, { recursive: true, force: true })
})
const deliver = () => deliverSnapshots(directory, "/project", new AbortController().signal, () => {})
async function seedLinked(priced = true) {
	const at = "2026-10-04T12:00:00.000Z"
	const common = {
		version: 1,
		workId: "55555555-5555-4555-8555-555555555555",
		sessionId: "private-session",
		recordedAt: at,
	}
	const source = {
		apiUrl: "https://api.example",
		gatewayUrl: "https://gateway.example/v1/chat/completions",
		credentialHash: "a".repeat(64),
	}
	const rows = [
		{
			...common,
			type: "request",
			requestId,
			startedAt: at,
			scope: { account: content.account, repository: "/private/repo/.git" },
		},
		{
			...common,
			type: "request_dispatch",
			requestId,
			dispatchedAt: at,
			billingSource: source,
			billingSelector: requestTagSelector(requestId, at),
		},
		...(priced
			? [
					{
						...common,
						type: "request_cost",
						requestId,
						billingSource: source,
						billingSelector: requestTagSelector(requestId, at),
						billingRows: [{ id: "44444444-4444-4444-8444-444444444444", costUsd: "0.123456789" }],
						billingLookup: { status: "priced", checkedAt: at, organizationId: org, userId: user },
					},
				]
			: []),
		{
			...common,
			type: "commit",
			repository: "/private/repo/.git",
			worktree: "/private/repo",
			sha: "b".repeat(40),
			pullRequests: [
				{
					provider: "github",
					id: "101",
					repositoryId: "42",
					host: "github.com",
					repository: "example/repo",
					number: 1,
					url: "https://github.com/example/repo/pull/1",
					state: "merged",
					mergedAt: "2026-10-04T13:00:00.000Z",
					closedAt: null,
					checkedAt: at,
					headSha: "b".repeat(40),
					mergeCommitSha: null,
				},
			],
		},
	]
	await mkdir(join(directory, "work-attribution"), { recursive: true })
	await writeFile(
		join(directory, "work-attribution", "source.jsonl"),
		`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
	)
}

describe("account-fenced reporting delivery", () => {
	it("reports existing work before a PR exists, then replaces it when the PR is discovered", async () => {
		await rm(join(directory, "pr-cost-reporting", "state.json"))
		await seedLinked()
		const path = join(directory, "work-attribution", "source.jsonl")
		const linked = await readFile(path, "utf8")
		await writeFile(
			path,
			`${linked
				.trim()
				.split("\n")
				.filter((line) => JSON.parse(line).type !== "commit")
				.join("\n")}\n`,
		)
		vi.spyOn(pullRequests, "lookupRepositoryIdentity").mockResolvedValue({
			...content.content.repository,
			name: "example/repo",
		})
		const sent: WireSnapshot[] = []
		http.mockImplementation(async (input, init) => {
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			const payload: WireSnapshot = JSON.parse(String(init?.body))
			sent.push(payload)
			return Response.json({ status: "accepted", revision: payload.revision, receivedAt: new Date().toISOString() })
		})
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(sent).toHaveLength(1)
		expect(sent[0]).toMatchObject({
			revision: "1",
			pullRequests: [],
			requests: [{ requestId, allocation: { kind: "unlinked", pullRequestIds: [] } }],
		})
		await writeFile(path, linked)
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(sent).toHaveLength(2)
		expect(sent[1]).toMatchObject({
			producerId: sent[0].producerId,
			revision: "2",
			pullRequests: [{ id: "101" }],
			requests: [{ requestId, allocation: { pullRequestIds: ["101"] } }],
		})
		expect(sent[1].requests).toHaveLength(1)
		expect(sent[1].requests[0].billingRecordIds).toEqual(sent[0].requests[0].billingRecordIds)
		expect(Date.parse(sent[1].generatedAt)).toBeGreaterThanOrEqual(Date.parse(sent[0].generatedAt))
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(sent).toHaveLength(2)
	})
	it.each([
		"success",
		"failed",
		"canceled",
	] as const)("records one %s delivery outcome and the remaining queue", async (outcome) => {
		const metric = vi.spyOn(health, "trackPRCostMetric").mockImplementation(() => {})
		const abort = new AbortController()
		http.mockImplementation(async (input) => {
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			if (outcome === "canceled") {
				abort.abort()
				throw abort.signal.reason
			}
			return outcome === "failed"
				? new Response(null, { status: 503 })
				: Response.json({ status: "accepted", revision: "1", receivedAt: new Date().toISOString() })
		})
		await deliverSnapshots(directory, "/project", abort.signal, () => {})
		await readReportingState(directory)
		expect(metric.mock.calls.map(([value]) => value).filter((value) => value.kind === "delivery")).toEqual([
			{ kind: "delivery", outcome },
		])
		expect(metric).toHaveBeenLastCalledWith({ kind: "queueDepth", value: outcome === "success" ? 0 : 1 })
	})
	it("uploads every same-repository post-merge candidate without holding the repository", async () => {
		await seedLinked()
		const path = join(directory, "work-attribution", "source.jsonl")
		const rows = (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		rows.find((row) => row.type === "request").startedAt = "2026-10-04T14:00:00.000Z"
		const commit = rows.find((row) => row.type === "commit")
		commit.pullRequests.push({
			...commit.pullRequests[0],
			id: "102",
			number: 2,
			url: "https://github.com/example/repo/pull/2",
		})
		await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
		const sent: WireSnapshot[] = []
		http.mockImplementation(async (input, init) => {
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			const payload: WireSnapshot = JSON.parse(String(init?.body))
			sent.push(payload)
			return Response.json({ status: "accepted", revision: payload.revision, receivedAt: new Date().toISOString() })
		})
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(sent).toHaveLength(1)
		expect(sent[0].requests[0]).toMatchObject({
			billingRecordIds: ["44444444-4444-4444-8444-444444444444"],
			allocation: { kind: "shared", pullRequestIds: ["101", "102"] },
		})
		expect((await readReportingState(directory)).error).toBeUndefined()
	})
	it("holds an undelivered repository withdrawal when the source ledger disappears after queueing", async () => {
		await seedLinked()
		http.mockImplementation(async (input, init) => {
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			const payload = JSON.parse(String(init?.body))
			return Response.json({ status: "accepted", revision: payload.revision, receivedAt: new Date().toISOString() })
		})
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		const path = join(directory, "work-attribution", "source.jsonl")
		await writeFile(path, (await readFile(path, "utf8")).replaceAll('"repositoryId":"42"', '"repositoryId":"43"'))
		const source = readWorkCostReport(directory)
		const built = buildSnapshots(source.records, source.report, new Map(), source.historyComplete, source.costRefreshes)
		await queueSnapshots(directory, built.snapshots, !built.incomplete)
		await rm(path)
		http.mockClear()
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(http).not.toHaveBeenCalled()
		expect(Object.values((await readReportingState(directory)).entries).every((entry) => entry.held)).toBe(true)
	})
	it("reports valid scoped work beside unrelated unscoped legacy history with incomplete coverage", async () => {
		await seedLinked()
		const sourcePath = join(directory, "work-attribution", "source.jsonl")
		await writeFile(
			sourcePath,
			// The legacy work has repository evidence, so its unscoped request leaves that history incomplete.
			`${await readFile(sourcePath, "utf8")}${JSON.stringify({ version: 1, type: "request", workId: "66666666-6666-4666-8666-666666666666", sessionId: "legacy-session", requestId: "77777777-7777-4777-8777-777777777777", recordedAt: "2026-10-01T10:00:00Z" })}\n${JSON.stringify({ version: 1, type: "commit", workId: "66666666-6666-4666-8666-666666666666", sessionId: "legacy-session", sha: "c".repeat(40), repository: "/project/.git", worktree: "/project", recordedAt: "2026-10-01T10:00:00Z", pullRequests: [] })}\n`,
		)
		let sent: Record<string, unknown> | undefined
		http.mockImplementation(async (input, init) => {
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			sent = JSON.parse(String(init?.body))
			return Response.json({ status: "accepted", revision: sent?.revision, receivedAt: new Date().toISOString() })
		})
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(sent).toMatchObject({ coverage: { observedRequests: 1, historyComplete: false } })
		expect(JSON.stringify(sent)).not.toContain("77777777-7777-4777-8777-777777777777")
		expect((await readReportingState(directory)).error).toContain("skipped")
	})
	it("holds a broken known group while uploading an independent healthy repository", async () => {
		await seedLinked()
		const sourcePath = join(directory, "work-attribution", "source.jsonl")
		const healthyId = "77777777-7777-4777-8777-777777777777"
		const healthy = (await readFile(sourcePath, "utf8"))
			.replaceAll(requestId, healthyId)
			.replaceAll('"repositoryId":"42"', '"repositoryId":"43"')
		const broken = {
			version: 1,
			type: "request",
			workId: "66666666-6666-4666-8666-666666666666",
			sessionId: "broken",
			requestId,
			recordedAt: "2026-10-01T10:00:00Z",
		}
		await writeFile(sourcePath, `${healthy}${JSON.stringify(broken)}\n`)
		const sent: string[] = []
		http.mockImplementation(async (input, init) => {
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			const payload = JSON.parse(String(init?.body))
			sent.push(payload.repository.id)
			return Response.json({ status: "accepted", revision: payload.revision, receivedAt: new Date().toISOString() })
		})
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(sent).toEqual(["43"])
		const held = Object.values((await readReportingState(directory)).entries).find(
			(entry) => entry.repository.id === "42",
		)
		expect(held).toMatchObject({ held: true, revision: "1", pending: { requests: [{ requestId }] } })
	})
	it.each([
		true,
		false,
	])("builds a full source snapshot with validated billing evidence (priced=%s)", async (priced) => {
		await seedLinked(priced)
		let sent: Record<string, unknown> | undefined
		http.mockImplementation(async (input, init) => {
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			sent = JSON.parse(String(init?.body))
			return Response.json({ status: "accepted", revision: sent?.revision, receivedAt: new Date().toISOString() })
		})
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(sent).toMatchObject({
			coverage: { observedRequests: 1, unpricedRequests: priced ? 0 : 1, historyComplete: true },
			requests: [{ requestId, billingRecordIds: priced ? ["44444444-4444-4444-8444-444444444444"] : [] }],
		})
		for (const privateValue of ["private-session", "/private", "0.123456789", "a".repeat(64)])
			expect(JSON.stringify(sent)).not.toContain(privateValue)
		http.mockClear()
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(http).not.toHaveBeenCalled()
	})
	it("does not look up or send with a different configured endpoint", async () => {
		config.endpoint = "https://other.example"
		await deliver()
		expect(http).not.toHaveBeenCalled()
	})
	it("does not follow a redirect or delete the durable attempt", async () => {
		http.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: new Response(null, { status: 302, headers: { Location: "https://elsewhere.example" } }),
		)
		await deliver()
		expect(http).toHaveBeenCalledTimes(2)
		expect(Object.values((await readReportingState(directory)).entries)[0].pending).toBeDefined()
	})
	it("retains a newer snapshot when the older in-flight snapshot is acknowledged", async () => {
		http.mockImplementation(async (input) => {
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			const next = structuredClone(content)
			next.content.requests[0].allocation.kind = "unknown"
			await queueSnapshots(directory, [next])
			return Response.json({ status: "accepted", revision: "1", receivedAt: new Date().toISOString() })
		})
		await deliver()
		expect(Object.values((await readReportingState(directory)).entries)[0].pending?.revision).toBe("2")
	})
	it("bounds an unfinished response body and keeps the snapshot for retry", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		try {
			http.mockImplementation(async (input) =>
				String(input).endsWith("api-keys:verify")
					? Response.json({ organizationId: org, userId: user })
					: new Response(new ReadableStream({ start() {} })),
			)
			const running = deliver()
			await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(2))
			await vi.advanceTimersByTimeAsync(5001)
			await running
			expect(Object.values((await readReportingState(directory)).entries)[0].pending).toBeDefined()
		} finally {
			vi.useRealTimers()
		}
	})
	it("persists retry timing when the complete reporting pass times out during upload", async () => {
		await seedLinked()
		http.mockImplementation(async (input, init) => {
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			return new Promise((_resolve, reject) =>
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
			)
		})
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		const entry = Object.values((await readReportingState(directory)).entries)[0]
		expect(entry.attempts).toBe(1)
		expect(entry.retryAt).toBeGreaterThan(Date.now())
	}, 8000)
	it("persists before dispatch and sends the allowlisted body without user or account fields", async () => {
		http.mockImplementation(async (input, init) => {
			expect(init?.redirect).toBe("error")
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			const persisted = JSON.parse(await readFile(join(directory, "pr-cost-reporting", "state.json"), "utf8"))
			expect(Object.values(persisted.entries)).toHaveLength(1)
			expect(String(input)).toBe(`https://api.example/ai-optimizer/v1beta/organizations/${org}/pr-cost-snapshots`)
			const payload = JSON.parse(String(init?.body))
			expect(payload.requests).toHaveLength(1)
			expect(payload.userId).toBeUndefined()
			expect(payload.account).toBeUndefined()
			return Response.json({ status: "accepted", revision: payload.revision, receivedAt: new Date().toISOString() })
		})
		await deliver()
		expect(http).toHaveBeenCalledTimes(2)
		expect(Object.values((await readReportingState(directory)).entries)[0].pending).toBeUndefined()
	})
	it.each([
		"user",
		"organization",
		"key-during-verify",
		"endpoint-during-verify",
	])("does not upload after %s changes", async (field) => {
		http.mockImplementation(async () => {
			if (field === "key-during-verify") config.key = "new-key"
			if (field === "endpoint-during-verify") config.endpoint = "https://other.example"
			return Response.json({
				organizationId: field === "organization" ? requestId : org,
				userId: field === "user" ? requestId : user,
			})
		})
		await deliver()
		expect(http).toHaveBeenCalledOnce()
		expect(Object.values((await readReportingState(directory)).entries)[0].pending).toBeDefined()
	})
	it("persists Retry-After and does not retry before its deadline", async () => {
		http.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: new Response("private response text", { status: 429, headers: { "Retry-After": "120" } }),
		)
		await deliver()
		const entry = Object.values((await readReportingState(directory)).entries)[0]
		expect(entry.retryAt).toBeGreaterThan(Date.now() + 119000)
		expect(entry.lastError).not.toContain("private response")
		http.mockClear()
		await deliver()
		expect(http).not.toHaveBeenCalled()
	})
	// Other 4xx responses, such as an endpoint that is not deployed yet, cannot be fixed by retrying.
	it.each([404, 400, 403])("backs off for hours after a permanent HTTP %s rejection", async (status) => {
		vi.spyOn(Math, "random").mockReturnValue(0.5)
		http.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: new Response(null, { status }),
		)
		const delays: number[] = []
		for (let attempt = 0; attempt < 4; attempt++) {
			const before = Date.now()
			await deliver()
			const entry = Object.values((await readReportingState(directory)).entries)[0]
			delays.push(Math.round((entry.retryAt - before) / 60_000))
			vi.spyOn(Date, "now").mockReturnValue(entry.retryAt + 1)
		}
		expect(delays).toEqual([60, 120, 240, 360])
	})
	it.each([
		[0, 48],
		[0.999, 72],
	])("spreads a rejection's retry by 20%% so rejected clients do not return together (random %s)", async (random, minutes) => {
		vi.spyOn(Math, "random").mockReturnValue(random)
		http.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: new Response(null, { status: 404 }),
		)
		const before = Date.now()
		await deliver()
		const entry = Object.values((await readReportingState(directory)).entries)[0]
		expect(Math.round((entry.retryAt - before) / 60_000)).toBe(minutes)
	})
	it.each([408, 503])("keeps retrying HTTP %s within a minute", async (status) => {
		http.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: new Response(null, { status }),
		)
		await deliver()
		expect(Object.values((await readReportingState(directory)).entries)[0].retryAt).toBeLessThanOrEqual(
			Date.now() + 60_000,
		)
	})
	it("retries a 429 without a PR_COST_LIMIT detail like an outage, backing off with jitter", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5)
		http.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: Response.json({ code: 8, message: "busy" }, { status: 429 }),
		)
		const delays: number[] = []
		for (let attempt = 0; attempt < 4; attempt++) {
			const before = Date.now()
			await deliver()
			const entry = Object.values((await readReportingState(directory)).entries)[0]
			delays.push(Math.round((entry.retryAt - before) / 1000))
			// Past both the retry deadline and this repository's upload window.
			vi.spyOn(Date, "now").mockReturnValue(Math.max(entry.retryAt, (entry.uploadedAt ?? 0) + UPLOAD_INTERVAL_MS) + 1)
		}
		expect(delays).toEqual([30, 60, 120, 240])
		expect(Object.values((await readReportingState(directory)).entries)[0]).toMatchObject({
			attempts: 4,
			lastError: "PR reporting returned HTTP 429",
		})
		expect(Object.values((await readReportingState(directory)).entries)[0].limit).toBeUndefined()
	})
	it("bounds a Retry-After longer than six hours", async () => {
		http.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: new Response(null, { status: 503, headers: { "Retry-After": "172800" } }),
		)
		const before = Date.now()
		await deliver()
		const { retryAt } = Object.values((await readReportingState(directory)).entries)[0]
		expect(retryAt - before).toBeGreaterThanOrEqual(LIMIT_RETRY_MS)
		expect(retryAt - Date.now()).toBeLessThanOrEqual(LIMIT_RETRY_MS)
	})
	it("cancels an in-flight upload when another instance opts out and discards its payload", async () => {
		let sent: (() => void) | undefined
		const sending = new Promise<void>((resolve) => {
			sent = resolve
		})
		http.mockImplementation(async (input, init) => {
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			sent?.()
			return new Promise((_resolve, reject) =>
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
			)
		})
		const running = deliver()
		await sending
		await setReportingEnabled(directory, false)
		await running
		const state = await readReportingState(directory)
		expect(Object.values(state.entries)[0].pending).toBeUndefined()
		expect(Object.values(state.entries)[0].requestHashes).toHaveLength(1)
		expect(JSON.stringify(state)).not.toContain(requestId)
	})
	it("keeps a malformed acknowledgement pending and never records response content", async () => {
		http.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: Response.json({
						status: "accepted",
						revision: "999",
						receivedAt: new Date().toISOString(),
						privateText: "secret",
					}),
		)
		await deliver()
		const state = await readReportingState(directory)
		expect(Object.values(state.entries)[0].pending).toBeDefined()
		expect(JSON.stringify(state)).not.toContain("secret")
	})
	it("explains a role that cannot upload and retries it slowly", async () => {
		http.mockImplementation(async () => Response.json({ message: "permission denied" }, { status: 403 }))
		const before = Date.now()
		await deliverSnapshots(directory, "/project", new AbortController().signal, () => {})
		const state = await readReportingState(directory)
		const [entry] = Object.values(state.entries)
		expect(entry.lastError).toBe(
			"PR reporting is not allowed for this API key: uploading PR costs needs an Owner or Member role (HTTP 403)",
		)
		expect(entry.retryAt - before).toBeGreaterThanOrEqual(0.8 * 60 * 60 * 1000)
	})
	it("still delivers when the opt-out watcher cannot start", async () => {
		vi.spyOn(fs, "watch").mockImplementation(() => {
			throw Object.assign(new Error("inotify watch limit reached"), { code: "ENOSPC" })
		})
		respond(accepted)
		await deliverSnapshots(directory, "/project", new AbortController().signal, () => {})
		expect(posts()).toHaveLength(1)
		expect(Object.values((await readReportingState(directory)).entries)[0].pending).toBeUndefined()
	})
	it("treats a record type this version does not know as incomplete history", async () => {
		await rm(join(directory, "pr-cost-reporting", "state.json"))
		await seedLinked()
		// A newer Kimchi sharing this history may write records this version cannot price or attribute.
		await writeFile(
			join(directory, "work-attribution", "newer.jsonl"),
			`${JSON.stringify({ version: 1, type: "future_record", workId: "55555555-5555-4555-8555-555555555555", sessionId: "newer", recordedAt: "2026-10-04T12:00:00.000Z" })}\n`,
		)
		respond(accepted)
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(posts()).toEqual([])
		expect((await readReportingState(directory)).error).toContain("could not capture a complete inventory")
	})
	it("delivers the queued report but withdraws nothing when a ledger cannot be read", async () => {
		await mkdir(join(directory, "work-attribution"), { recursive: true })
		await writeFile(join(directory, "work-attribution", "source.jsonl"), "{broken\n")
		respond(accepted)
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		// The report queued from the last complete capture still goes out; the unreadable ledger queues nothing new.
		expect(posts().map((payload) => [payload.revision, payload.requests.length])).toEqual([["1", 1]])
		expect((await readReportingState(directory)).error).toContain("could not capture a complete inventory")
	})
})

const second = "55555555-5555-4555-8555-555555555551"
const third = "55555555-5555-4555-8555-555555555552"
const posts = () =>
	http.mock.calls
		.filter(([url]) => String(url).endsWith("/pr-cost-snapshots"))
		.map(([, init]): WireSnapshot => JSON.parse(String(init?.body)))
const respond = (reply: (payload: WireSnapshot) => Response) =>
	http.mockImplementation(async (input, init) =>
		String(input).endsWith("api-keys:verify")
			? Response.json({ organizationId: org, userId: user })
			: reply(JSON.parse(String(init?.body))),
	)
const accepted = (payload: WireSnapshot) =>
	Response.json({ status: "accepted", revision: payload.revision, receivedAt: new Date().toISOString() })
const inventory = (requestIds: string[], repositoryId = "42"): RepositorySnapshot => ({
	account: content.account,
	content: {
		...content.content,
		repository: { ...content.content.repository, id: repositoryId },
		requests: requestIds.map((id) => ({ ...content.content.requests[0], requestId: id })),
		coverage: { observedRequests: requestIds.length, unpricedRequests: requestIds.length, historyComplete: true },
	},
})
const entryFor = async (repositoryId: string) =>
	Object.values((await readReportingState(directory)).entries).find((entry) => entry.repository.id === repositoryId)

describe("upload window", () => {
	it("uploads rapid ordinary changes once per five-minute window, sending the newest", async () => {
		respond(accepted)
		await deliver()
		await queueSnapshots(directory, [inventory([requestId, second])])
		await deliver()
		await queueSnapshots(directory, [inventory([requestId, second, third])])
		await deliver()
		expect(posts().map((payload) => payload.revision)).toEqual(["1"])
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + UPLOAD_INTERVAL_MS)
		await deliver()
		expect(posts().map((payload) => [payload.revision, payload.requests.length])).toEqual([
			["1", 1],
			["3", 3],
		])
	})
	it("sends a PR opening at once inside the window", async () => {
		respond(accepted)
		await deliver()
		const linked = inventory([requestId])
		linked.content.pullRequests = [
			{ id: "101", number: 1, url: "https://github.com/example/repo/pull/1", state: "open" },
		]
		linked.content.requests[0].allocation = { kind: "pull-request", pullRequestIds: ["101"], method: "native" }
		await queueSnapshots(directory, [linked])
		await deliver()
		expect(posts().map((payload) => payload.revision)).toEqual(["1", "2"])
	})
	it("sends the next snapshot at once after /pr-reporting on", async () => {
		respond(accepted)
		await deliver()
		await queueSnapshots(directory, [inventory([requestId, second])])
		await deliver()
		expect(posts()).toHaveLength(1)
		await setReportingEnabled(directory, true)
		await deliver()
		expect(posts().map((payload) => payload.revision)).toEqual(["1", "2"])
	})
})

const limitDetail = (scope: string, limit: string, current: string, maximum: string) => ({
	"@type": "type.googleapis.com/google.rpc.ErrorInfo",
	reason: "PR_COST_LIMIT",
	domain: "ai-optimizer",
	metadata: { scope, limit, current, maximum },
})
const limited = (scope: string, limit: string, current: string, maximum: string) =>
	Response.json(
		{
			code: 8,
			message: "PR cost reporting resource limit exceeded",
			details: [limitDetail(scope, limit, current, maximum)],
		},
		{ status: 429 },
	)

describe("server limits", () => {
	it("treats a producer limit as quota: about six hours on its own counter, while another repository uploads", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5)
		await queueSnapshots(directory, [content, inventory([second], "43")])
		respond((payload) =>
			payload.repository.id === "42" ? limited("producer", "repositories", "101", "100") : accepted(payload),
		)
		const before = Date.now()
		await deliver()
		const entry = await entryFor("42")
		expect(entry).toMatchObject({
			attempts: 0,
			limit: { scope: "producer", limit: "repositories", current: 101, maximum: 100 },
		})
		expect((entry?.retryAt ?? 0) - before).toBeGreaterThanOrEqual(LIMIT_RETRY_MS)
		expect((entry?.retryAt ?? 0) - Date.now()).toBeLessThanOrEqual(LIMIT_RETRY_MS)
		expect((await entryFor("43"))?.pending).toBeUndefined()
		const state = await readReportingState(directory)
		expect(JSON.stringify(state)).not.toContain("resource limit exceeded")
		expect(statusText(state, undefined).text).toContain(
			"github.com repository 42: producer limit reached (repositories 101 of 100). Not reported; next try in about 6 h.",
		)
		http.mockClear()
		await deliver()
		expect(posts()).toEqual([])
	})
	it.each([
		["organization", "this organization"],
		["contributor", "your account in this organization"],
		["frozen", "this organization"],
	])("pauses the whole account for a %s limit but still sends a withdrawal", async (scope, owner) => {
		await queueSnapshots(directory, [content, inventory([second], "43")])
		respond((payload) => (payload.requests.length ? limited(scope, "requests", "50000", "50000") : accepted(payload)))
		await deliver()
		expect(posts()).toHaveLength(1)
		const state = await readReportingState(directory)
		expect(Object.values(state.paused ?? {})).toMatchObject([{ limit: { scope, limit: "requests" } }])
		expect(statusText(state, undefined).text).toContain(
			`PR cost reporting paused for ${owner}: ${scope} limit reached (requests 50000 of 50000). Ask an admin to free space or wait; next try in about`,
		)
		// The request moves to repository 43, so repository 42 is withdrawn; the withdrawal frees space.
		http.mockClear()
		await queueSnapshots(directory, [inventory([second, requestId], "43")], true)
		await deliver()
		expect(posts().map((payload) => [payload.repository.id, payload.requests.length])).toEqual([["42", 0]])
		expect((await readReportingState(directory)).paused).toBeDefined()
	})
	it("trims to a server snapshot limit and sends the smaller snapshot after the wait", async () => {
		await rm(join(directory, "pr-cost-reporting", "state.json"))
		await seedLinked()
		const path = join(directory, "work-attribution", "source.jsonl")
		const rows = (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		const later = "66666666-6666-4666-8666-666666666666"
		rows.push({
			...rows.find((row) => row.type === "request"),
			requestId: later,
			startedAt: "2026-10-04T12:30:00.000Z",
			recordedAt: "2026-10-04T12:30:00.000Z",
		})
		await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
		let full = true
		respond((payload) => (full ? limited("snapshot", "requests", "2", "1") : accepted(payload)))
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		expect(posts().map((payload) => payload.requests.length)).toEqual([2])
		expect(await entryFor("42")).toMatchObject({
			limit: { scope: "snapshot", limit: "requests" },
			learned: { requests: 1 },
		})
		// The next pass queues the smaller snapshot at once, but it waits out the limit like any other.
		await run()
		const waiting = await entryFor("42")
		expect(waiting).toMatchObject({ trimmed: 1, pending: { requests: [{ requestId: later }] } })
		expect(posts()).toHaveLength(1)
		full = false
		vi.spyOn(Date, "now").mockReturnValue((waiting?.retryAt ?? 0) + 1)
		await run()
		expect(posts().at(-1)).toMatchObject({
			requests: [{ requestId: later }],
			coverage: { observedRequests: 1, historyComplete: false, trimmedRequests: 1 },
		})
		const sent = await entryFor("42")
		expect(sent?.limit).toBeUndefined()
		expect(sent?.learned?.requests).toBe(1)
	})
	it("retries an oversized 429 body as an outage without reading past 64 KiB", async () => {
		respond(
			() =>
				new Response(
					JSON.stringify({ details: [limitDetail("organization", "bytes", "1", "1")], padding: "x".repeat(70 * 1024) }),
					{ status: 429 },
				),
		)
		await deliver()
		const entry = await entryFor("42")
		expect(entry).toMatchObject({ attempts: 1, lastError: "PR reporting returned HTTP 429" })
		expect(entry?.limit).toBeUndefined()
		expect((await readReportingState(directory)).paused).toBeUndefined()
		expect(entry?.retryAt).toBeLessThanOrEqual(Date.now() + 36_000)
	})
	it("reads only a PR_COST_LIMIT ErrorInfo from the ai-optimizer domain", () => {
		const detail = limitDetail("producer", "snapshots", "100", "100")
		expect(serverLimit({ details: [detail] }, 5)).toEqual({
			scope: "producer",
			limit: "snapshots",
			current: 100,
			maximum: 100,
			at: 5,
		})
		expect(serverLimit({ details: [limitDetail("snapshot", "windowedPullRequests", "2001", "2000")] }, 5)).toEqual({
			scope: "snapshot",
			limit: "windowedPullRequests",
			current: 2001,
			maximum: 2000,
			at: 5,
		})
		expect(serverLimit({ details: [{ ...detail, domain: "elsewhere" }] }, 5)).toBeUndefined()
		expect(serverLimit({ details: [{ ...detail, reason: "QUOTA" }] }, 5)).toBeUndefined()
		expect(serverLimit({ code: 8, message: "busy" }, 5)).toBeUndefined()
		// Unknown values never reach durable state; the rejection still counts as a limit.
		expect(serverLimit({ details: [limitDetail("galaxy", "planets", "1.5", "-1")] }, 5)).toEqual({ at: 5 })
	})
})

describe("repository identity for work without a PR", () => {
	it.each([
		["unsupported", "This repository has no supported GitHub or GitLab remote.", true],
		["retry", "GitHub lookup timed out. Kimchi will retry.", false],
	] as const)("leaves other repositories complete only when a lookup fails as %s", async (kind, message, complete) => {
		await rm(join(directory, "pr-cost-reporting", "state.json"))
		await seedLinked()
		const path = join(directory, "work-attribution", "source.jsonl")
		const startedAt = new Date().toISOString()
		await writeFile(
			path,
			`${await readFile(path, "utf8")}${JSON.stringify({
				version: 1,
				type: "request",
				workId: "77777777-7777-4777-8777-777777777777",
				sessionId: "scratch-session",
				requestId: "66666666-6666-4666-8666-666666666666",
				startedAt,
				recordedAt: startedAt,
				scope: { account: content.account, repository: "/scratch/.git" },
			})}\n`,
		)
		vi.spyOn(pullRequests, "lookupRepositoryIdentity").mockRejectedValue(new pullRequests.LookupError(message, kind))
		respond(accepted)
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(posts().map((payload) => [payload.repository.id, payload.coverage.historyComplete])).toEqual([
			["42", complete],
		])
		const { error } = await readReportingState(directory)
		if (complete) expect(error).toBeUndefined()
		else expect(error).toContain("skipped 1 request(s) without original account or repository evidence")
	})
	it("delivers a known repository while another lookup times out, then retries that lookup after cooldown", async () => {
		await seedLinked()
		const path = join(directory, "work-attribution", "source.jsonl")
		const source = await readFile(path, "utf8")
		await writeFile(
			path,
			`${source}${JSON.stringify({
				version: 1,
				type: "request",
				workId: "77777777-7777-4777-8777-777777777777",
				sessionId: "other-session",
				requestId: "66666666-6666-4666-8666-666666666666",
				startedAt: "2026-10-04T12:00:00.000Z",
				recordedAt: "2026-10-04T12:00:00.000Z",
				scope: { account: content.account, repository: "/slow/.git" },
			})}\n`,
		)
		const lookup = vi.spyOn(pullRequests, "lookupRepositoryIdentity").mockImplementation(
			(_path, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true })
				}),
		)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		expect(http.mock.calls.filter(([url]) => String(url).endsWith("pr-cost-snapshots"))).toHaveLength(1)
		await run()
		expect(lookup).toHaveBeenCalledOnce()
		const next = Date.now() + 31_000
		vi.spyOn(Date, "now").mockReturnValue(next)
		lookup.mockResolvedValue({ provider: "github", host: "github.com", name: "team/slow", id: "99" })
		await run()
		expect(lookup).toHaveBeenCalledTimes(2)
		expect(
			Object.values((await readReportingState(directory)).entries).some((entry) => entry.repository.id === "99"),
		).toBe(true)
	})
	it("refreshes cached repository identity after five minutes", async () => {
		await seedLinked()
		const path = join(directory, "work-attribution", "source.jsonl")
		const rows = (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.filter((line) => JSON.parse(line).type !== "commit")
		await writeFile(path, `${rows.join("\n")}\n`)
		const lookup = vi.spyOn(pullRequests, "lookupRepositoryIdentity").mockResolvedValue({
			provider: "github",
			host: "github.com",
			name: "team/first",
			id: "98",
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		await run()
		expect(lookup).toHaveBeenCalledOnce()
		const next = Date.now() + 5 * 60_000
		vi.spyOn(Date, "now").mockReturnValue(next)
		lookup.mockResolvedValue({ provider: "github", host: "github.com", name: "team/moved", id: "99" })
		await run()
		expect(lookup).toHaveBeenCalledTimes(2)
	})
	it("queues pre-PR work from a dozen repositories without re-fetching each repository's identity every pass", async () => {
		await rm(join(directory, "pr-cost-reporting", "state.json"))
		const rows = Array.from({ length: 12 }, (_, index) => ({
			version: 1,
			type: "request",
			workId: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
			sessionId: `session-${index}`,
			requestId: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
			recordedAt: "2026-10-04T12:00:00.000Z",
			startedAt: "2026-10-04T12:00:00.000Z",
			scope: { account: content.account, repository: `/src/repo-${index}/.git` },
		}))
		await mkdir(join(directory, "work-attribution"), { recursive: true })
		await writeFile(
			join(directory, "work-attribution", "source.jsonl"),
			`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		)
		let lookups = 0
		// A realistic lookup: Git remote read, CLI token lookup and one provider API round-trip.
		vi.spyOn(pullRequests, "lookupRepositoryIdentity").mockImplementation(async (path) => {
			lookups++
			await new Promise((resolve) => setTimeout(resolve, 450))
			return {
				provider: "github",
				host: "github.com",
				name: `team/${path.split("/")[2]}`,
				id: String(1000 + Number(path.split("-")[1].split("/")[0])),
			}
		})
		for (let pass = 0; pass < 3; pass++)
			await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		const queued = Object.values((await readReportingState(directory)).entries).filter(
			(entry) => entry.repository.provider === "github" && Number(entry.repository.id) >= 1000,
		)
		expect(queued).toHaveLength(12)
		// One lookup per repository, plus at most one abandoned when a pass deadline interrupts it.
		expect(lookups).toBeLessThanOrEqual(13)
	}, 30_000)
})

describe("journals with a torn final append", () => {
	it("keeps reporting after the crashed session appends another record", async () => {
		await rm(join(directory, "pr-cost-reporting", "state.json"))
		await seedLinked()
		vi.stubEnv("PI_CODING_AGENT_DIR", directory)
		await writeFile(join(directory, "work-attribution", "crashed.jsonl"), '{"type":"request","requestId":"0b8f')
		appendWorkRecord(
			createContext({ cwd: "/project", sessionManager: { getSessionId: () => "crashed" } }),
			{ type: "work" },
			"55555555-5555-4555-8555-555555555555",
		)
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		const sent = http.mock.calls.filter(([url]) => String(url).endsWith("/pr-cost-snapshots"))
		expect(sent).toHaveLength(1)
		expect(
			JSON.parse(String(sent[0][1]?.body)).requests.map((request: { requestId: string }) => request.requestId),
		).toEqual([requestId])
		expect((await readReportingState(directory)).error).toBeUndefined()
	})
	it("keeps reporting recorded work when another session's journal ends with a partial line", async () => {
		await rm(join(directory, "pr-cost-reporting", "state.json"))
		await seedLinked()
		// A process died during its final append; that record was never complete or reported.
		await writeFile(join(directory, "work-attribution", "crashed.jsonl"), '{"type":"request","requestId":"0b8f')
		const sent: WireSnapshot[] = []
		http.mockImplementation(async (input, init) => {
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			const payload: WireSnapshot = JSON.parse(String(init?.body))
			sent.push(payload)
			return Response.json({ status: "accepted", revision: payload.revision, receivedAt: new Date().toISOString() })
		})
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(sent.map((payload) => payload.requests.map((request) => request.requestId))).toEqual([[requestId]])
	})
})
