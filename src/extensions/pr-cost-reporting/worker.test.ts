import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as health from "../telemetry/pr-cost.js"
import { readWorkCostReport } from "../work-attribution/cost-sync.js"
import { queueSnapshots, readReportingState, setReportingEnabled } from "./queue.js"
import { buildSnapshots, type RepositorySnapshot, type WireSnapshot } from "./snapshot.js"
import { deliverSnapshots, reconcileReporting } from "./worker.js"

const config = vi.hoisted(() => ({ key: "test-key", endpoint: "https://api.example" }))
vi.mock("../../config.js", () => ({
	loadConfig: () => ({ apiKey: config.key }),
	resolveEndpoints: () => ({ platformApiUrl: config.endpoint }),
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
		{ ...common, type: "request_response", requestId, billingSource: source, response: { promptId: requestId } },
		...(priced
			? [
					{
						...common,
						type: "request_cost",
						requestId,
						billingSource: source,
						promptId: requestId,
						billingRows: [{ id: "44444444-4444-4444-8444-444444444444", promptId: requestId, costUsd: "0.123456789" }],
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
			`${await readFile(sourcePath, "utf8")}${JSON.stringify({ version: 1, type: "request", workId: "66666666-6666-4666-8666-666666666666", sessionId: "legacy-session", requestId: "77777777-7777-4777-8777-777777777777", recordedAt: "2026-10-01T10:00:00Z" })}\n`,
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
	it("honors a Retry-After longer than one day", async () => {
		http.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: new Response(null, { status: 429, headers: { "Retry-After": "172800" } }),
		)
		await deliver()
		expect(Object.values((await readReportingState(directory)).entries)[0].retryAt).toBeGreaterThan(
			Date.now() + 172799000,
		)
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
	it("does not withdraw previous claims when a ledger cannot be read", async () => {
		await mkdir(join(directory, "work-attribution"), { recursive: true })
		await writeFile(join(directory, "work-attribution", "source.jsonl"), "{broken\n")
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		const state = await readReportingState(directory)
		expect(Object.values(state.entries)[0].pending?.requests).toHaveLength(1)
		expect(http).not.toHaveBeenCalled()
	})
})
