import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as durableFiles from "../../config/json.js"
import { createContext } from "../__mocks__/context.js"
import * as providerApi from "../pull-request-status/provider-api.js"
import { LookupError } from "../pull-request-status/provider-records.js"
import * as health from "../telemetry/pr-cost.js"
import { requestTagSelector } from "../work-attribution/billing-source.js"
import * as costs from "../work-attribution/costs.js"
import * as summary from "../work-attribution/summary.js"
import { flushWorkSummaries } from "../work-attribution/summary.js"
import { appendWorkRecord } from "../work-attribution.js"
import * as eventBuilder from "./events.js"
import { reportJournalProblems } from "./ledger/import.js"
import * as outbox from "./ledger/outbox.js"
import { backendFor, readRecords } from "./ledger/records.js"
import {
	pendingFrozenSnapshots,
	queueSnapshots,
	readReportingState,
	setReportingEnabled,
	UPLOAD_INTERVAL_MS,
} from "./queue.js"
import { accountKey, type RepositorySnapshot, type WireSnapshot } from "./snapshot.js"
import { statusText } from "./status.js"
import { deliverEvents, deliverSnapshots, LIMIT_RETRY_MS, reconcileReporting, serverLimit } from "./worker.js"

const config = vi.hoisted(() => ({ key: "test-key", endpoint: "https://api.example" }))
vi.mock("node:fs", async (original) => ({ ...(await original<typeof fs>()) }))
vi.mock("../work-attribution/costs.js", async (original) => ({ ...(await original<typeof costs>()) }))
vi.mock("../work-attribution/summary.js", async (original) => ({ ...(await original<typeof summary>()) }))
vi.mock("./events.js", () => ({ buildEvents: vi.fn(() => ({ accounts: [], unresolved: [] })) }))
vi.mock("./ledger/outbox.js", async (original) => ({ ...(await original<typeof outbox>()), observeEvents: vi.fn() }))
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
	vi.mocked(eventBuilder.buildEvents).mockClear()
	vi.mocked(outbox.observeEvents).mockClear()
	config.key = "test-key"
	config.endpoint = "https://api.example"
	http.mockReset().mockImplementation(async (input, init) =>
		String(input).endsWith("api-keys:verify")
			? Response.json({ organizationId: org, userId: user })
			: Response.json({
					status: "accepted",
					revision: JSON.parse(String(init?.body)).revision,
					receivedAt: new Date().toISOString(),
				}),
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
const capturedReport = () => vi.mocked(eventBuilder.buildEvents).mock.calls.at(-1)?.[1]
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
			startedAt: at,
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
	it("makes no authentication request when the event outbox is empty", async () => {
		await deliverEvents(directory, "/project", new AbortController().signal, () => {})
		expect(http).not.toHaveBeenCalled()
	})
	it.each([
		"backoff",
		"explicit resume",
		"another eligible account",
	])("checks event schedules before authentication: %s", async (mode) => {
		const backend = backendFor(directory)
		const accountId = accountKey(content.account)
		const batchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		const batch = {
			id: batchId,
			accountKey: accountId,
			body: new Uint8Array(),
			eventIds: [],
			createdAt: Date.now(),
			orderKey: "",
		}
		backend.insertOutboxBatch(batch)
		backend.putNote(
			"pr-cost-delivery",
			accountId,
			JSON.stringify({
				batchId,
				attempts: 1,
				retryAt: Date.now() + 60_000,
				resume: backend.getNote("agent", "legacy-snapshot-resume"),
			}),
		)
		if (mode === "explicit resume") await setReportingEnabled(directory, true)
		if (mode === "another eligible account")
			backend.insertOutboxBatch({ ...batch, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", accountKey: "other-account" })
		await deliverEvents(directory, "/project", new AbortController().signal, () => {})
		expect(http).toHaveBeenCalledTimes(mode === "backoff" ? 0 : 1)
		if (mode !== "backoff") expect(String(http.mock.calls[0][0])).toContain("api-keys:verify")
	})

	it("uploads snapshots and events with the SSO credential when no API key is configured", async () => {
		config.key = ""
		const agentDir = join(directory, "agent")
		await mkdir(agentDir, { recursive: true })
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ "kimchi-dev": { type: "oauth", access: "oauth-access", refresh: "r", orgId: org } }),
		)
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
		await deliver()
		const batch = {
			id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			accountKey: accountKey(content.account),
			body: new TextEncoder().encode("{}"),
			eventIds: [],
			createdAt: Date.now(),
			orderKey: "",
		}
		backendFor(directory).insertOutboxBatch(batch)
		// Only the request headers matter here, so skip encoding a valid event batch.
		vi.spyOn(outbox, "pendingBatch").mockReturnValue(batch)
		await deliverEvents(directory, "/project", new AbortController().signal, () => {})
		for (const route of ["pr-cost-snapshots", "pr-cost-events:batchIngest"]) {
			const upload = http.mock.calls.find(([url]) => String(url).endsWith(route))
			const headers = new Headers(upload?.[1]?.headers)
			expect(headers.get("authorization")).toBe("Bearer oauth-access")
			expect(headers.get("x-castai-organization-id")).toBe(org)
		}
	})

	it("keeps an event batch without an error when the credential changes during its upload", async () => {
		// Events wait until the legacy snapshot queued for this account drains.
		await deliver()
		const batch = {
			id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			accountKey: accountKey(content.account),
			body: new TextEncoder().encode("{}"),
			eventIds: [],
			createdAt: Date.now(),
			orderKey: "",
		}
		backendFor(directory).insertOutboxBatch(batch)
		vi.spyOn(outbox, "pendingBatch").mockReturnValue(batch)
		http.mockImplementation(async (input) => {
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			// An SSO refresh rewrites the credential while the batch is in flight.
			config.key = "refreshed-key"
			return Response.json({ batchId: batch.id, receipts: [] })
		})
		await expect(deliverEvents(directory, "/project", new AbortController().signal, () => {})).resolves.toBeUndefined()
		expect(http.mock.calls.some(([url]) => String(url).endsWith("pr-cost-events:batchIngest"))).toBe(true)
		expect((await readReportingState(directory)).error).toBeUndefined()
		expect(backendFor(directory).getOutboxBatch(batch.accountKey)?.id).toBe(batch.id)
		expect(backendFor(directory).getNote("pr-cost-delivery", batch.accountKey)).toBeUndefined()
	})

	it("queues the producer's facts and original hashes under their original account", async () => {
		await seedLinked(false)
		const group = {
			account: content.account,
			facts: [
				{
					entityId: "work",
					source: "kimchi",
					sourceVersion: "test",
					deviceId: requestId,
					observeTime: "2026-10-04T12:00:00Z",
					work: { reason: "explicit", quality: "confirmed" },
				},
			],
			recordHashes: ["a".repeat(64)],
		}
		vi.mocked(eventBuilder.buildEvents).mockReturnValueOnce({ accounts: [group], unresolved: [] })
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(outbox.observeEvents).toHaveBeenCalledWith(
			directory,
			accountKey(content.account),
			group.facts,
			group.recordHashes,
			expect.any(Function),
		)
		expect(
			vi
				.mocked(eventBuilder.buildEvents)
				.mock.calls.at(-1)?.[0]
				.map((row) => JSON.parse(row.body)),
		).toEqual(readRecords(directory))
	})

	it("delivers frozen legacy bytes when an older writer replaces the queue during verification", async () => {
		const original = JSON.stringify(Object.values((await readReportingState(directory)).entries)[0].pending)
		let replaced = false
		const bodies: string[] = []
		http.mockImplementation(async (input, init) => {
			if (String(input).endsWith("api-keys:verify")) {
				if (!replaced) {
					replaced = true
					await queueSnapshots(directory, [
						{
							...content,
							content: {
								...content.content,
								requests: content.content.requests.map((request) => ({
									...request,
									allocation: { ...request.allocation, kind: "unknown" },
								})),
							},
						},
					])
				}
				return Response.json({ organizationId: org, userId: user })
			}
			bodies.push(String(init?.body))
			const snapshot = JSON.parse(String(init?.body))
			return Response.json({ status: "accepted", revision: snapshot.revision, receivedAt: new Date().toISOString() })
		})
		await deliver()
		expect(bodies).toEqual([original])
		expect(Object.values((await readReportingState(directory)).entries)[0].pending).toMatchObject({
			revision: "2",
			requests: [{ allocation: { kind: "unknown" } }],
		})
		await deliver()
		expect(posts().map((snapshot) => snapshot.revision)).toEqual(["1", "2"])
		expect(Object.values((await readReportingState(directory)).entries)[0].pending).toBeUndefined()
	})

	it("retries the original frozen body after a lost ACK even when a newer revision was accepted", async () => {
		const original = JSON.stringify(Object.values((await readReportingState(directory)).entries)[0].pending)
		const bodies: string[] = []
		http.mockImplementation(async (input, init) => {
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			const body = String(init?.body)
			bodies.push(body)
			if (bodies.length === 1) {
				await queueSnapshots(directory, [inventory([requestId, second])])
				throw new Error("ACK lost")
			}
			const snapshot: WireSnapshot = JSON.parse(body)
			return Response.json({
				status: snapshot.revision === "1" ? "stale" : "accepted",
				revision: "2",
				receivedAt: new Date().toISOString(),
			})
		})
		await deliver()
		await deliver()
		expect(bodies.map((body) => JSON.parse(body).revision)).toEqual(["1", "2"])
		expect(Object.values((await readReportingState(directory)).entries)[0].pending).toBeUndefined()
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + UPLOAD_INTERVAL_MS)
		await deliver()
		expect(bodies.map((body) => JSON.parse(body).revision)).toEqual(["1", "2", "1"])
		expect(bodies[2]).toBe(original)
		expect(Object.values((await readReportingState(directory)).entries)[0].revision).toBe("2")
		await deliver()
		expect(bodies).toHaveLength(3)
	})

	it("freezes an older writer's replacement under the capture lock without publishing a new legacy inventory", async () => {
		await seedLinked()
		const read = summary.importWorkRecordsAsync
		let replacement: string | undefined
		vi.spyOn(summary, "importWorkRecordsAsync").mockImplementationOnce(async (...args) => {
			const records = await read(...args)
			await queueSnapshots(directory, [
				{
					...content,
					content: {
						...content.content,
						requests: content.content.requests.map((request) => ({
							...request,
							allocation: { ...request.allocation, kind: "unknown" },
						})),
					},
				},
			])
			replacement = JSON.stringify(Object.values((await readReportingState(directory)).entries)[0].pending)
			return records
		})
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(posts().map((snapshot) => snapshot.revision)).toEqual(["1", "2"])
		expect(posts().map((snapshot) => snapshot.requests[0].allocation.kind)).toEqual(["unlinked", "unknown"])
		expect(http.mock.calls.filter(([input]) => String(input).endsWith("pr-cost-snapshots"))[1]?.[1]?.body).toBe(
			replacement,
		)
	})

	it("recovers a durable frozen ACK when legacy file cleanup fails without resending", async () => {
		const path = join(directory, "pr-cost-reporting/state.json")
		const original = await readFile(path)
		const write = durableFiles.writeFileDurably
		const cleanup = vi.spyOn(durableFiles, "writeFileDurably").mockImplementation(async (target, body, check) => {
			if (
				target === path &&
				!Object.values(JSON.parse(String(body)).entries).some((entry) => (entry as { pending?: unknown }).pending)
			)
				throw new Error("legacy cleanup failed")
			return write(target, body, check)
		})
		await deliver()
		expect(posts()).toHaveLength(1)
		expect(await readFile(path)).toEqual(original)
		cleanup.mockRestore()
		await deliver()
		expect(posts()).toHaveLength(1)
		expect(Object.values((await readReportingState(directory)).entries)[0].pending).toBeUndefined()
	})

	it("captures work before a PR exists and captures its later PR without writing legacy inventory", async () => {
		await rm(join(directory, "pr-cost-reporting/state.json"))
		await seedLinked()
		const path = join(directory, "work-attribution/source.jsonl")
		const linked = await readFile(path, "utf8")
		await writeFile(
			path,
			`${linked
				.trim()
				.split("\n")
				.filter((line) => JSON.parse(line).type !== "commit")
				.join("\n")}\n`,
		)
		vi.spyOn(providerApi, "lookupRepositoryIdentity").mockResolvedValue({
			...content.content.repository,
			name: "example/repo",
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		expect(capturedReport()?.requests[0]).toMatchObject({ requestId, pullRequestIds: [] })
		const firstProducer = vi.mocked(eventBuilder.buildEvents).mock.calls.at(-1)?.[3]
		await writeFile(path, linked)
		await run()
		expect(capturedReport()?.requests[0].pullRequestIds).toHaveLength(1)
		expect(capturedReport()?.pullRequests[0].pullRequest).toMatchObject({ id: "101", repositoryId: "42" })
		expect(vi.mocked(eventBuilder.buildEvents).mock.calls.at(-1)?.[3]).toBe(firstProducer)
		expect(posts()).toEqual([])
		expect((await readReportingState(directory)).entries).toEqual({})
		// Import changes the authority fingerprint; one following pass catches up to that prefix.
		await run()
		const captures = vi.mocked(eventBuilder.buildEvents).mock.calls.length
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(captures)
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
	it("retains every same-repository post-merge candidate for common event construction", async () => {
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
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(capturedReport()?.requests[0]).toMatchObject({
			allocation: "post-merge",
		})
		expect(capturedReport()?.requests[0].pullRequestIds).toHaveLength(2)
		expect(posts().map((snapshot) => snapshot.revision)).toEqual(["1"])
		expect((await readReportingState(directory)).error).toBeUndefined()
	})
	it("does not manufacture a legacy withdrawal when source records disappear", async () => {
		await seedLinked()
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		const path = join(directory, "work-attribution/source.jsonl")
		await rm(path)
		const before = posts().length
		await run()
		expect(posts()).toHaveLength(before)
		expect(Object.values((await readReportingState(directory)).entries).map((entry) => entry.revision)).toEqual(["1"])
	})
	it("reports valid scoped work beside unrelated unscoped legacy history with incomplete coverage", async () => {
		await seedLinked()
		const sourcePath = join(directory, "work-attribution", "source.jsonl")
		await writeFile(
			sourcePath,
			// The legacy work has repository evidence, so its unscoped request leaves that history incomplete.
			`${await readFile(sourcePath, "utf8")}${JSON.stringify({ version: 1, type: "request", workId: "66666666-6666-4666-8666-666666666666", sessionId: "legacy-session", requestId: "77777777-7777-4777-8777-777777777777", recordedAt: "2026-10-01T10:00:00Z" })}\n${JSON.stringify({ version: 1, type: "commit", workId: "66666666-6666-4666-8666-666666666666", sessionId: "legacy-session", sha: "c".repeat(40), repository: "/project/.git", worktree: "/project", recordedAt: "2026-10-01T10:00:00Z", pullRequests: [] })}\n`,
		)
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(capturedReport()?.requests.find((row) => row.requestId === requestId)?.account).toEqual(content.account)
		expect(
			capturedReport()?.requests.find((row) => row.requestId === "77777777-7777-4777-8777-777777777777")?.account,
		).toBeNull()
		expect(
			vi
				.mocked(eventBuilder.buildEvents)
				.mock.calls.at(-1)?.[0]
				.map((row) => JSON.parse(row.body)),
		).toContainEqual(expect.objectContaining({ sessionId: "legacy-session", type: "request" }))
	})
	it("keeps broken and healthy source evidence separate for the common producer", async () => {
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
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(capturedReport()?.requests.find((row) => row.requestId === healthyId)?.account).toEqual(content.account)
		expect(capturedReport()?.requests.find((row) => row.requestId === requestId)?.account).toBeNull()
		expect(posts().map((snapshot) => snapshot.repository.id)).toEqual(["42"])
	})
	it.each([true, false])("passes validated billing evidence to the common producer (priced=%s)", async (priced) => {
		await seedLinked(priced)
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(capturedReport()?.requests[0]).toMatchObject({
			requestId,
			billingRecordIds: priced ? ["44444444-4444-4444-8444-444444444444"] : [],
		})
		const stored = vi.mocked(eventBuilder.buildEvents).mock.calls.at(-1)?.[0]
		// The producer receives each journal line's original hash, not a hash of its reserialized body.
		const lines = (await readFile(join(directory, "work-attribution", "source.jsonl"), "utf8")).trimEnd().split("\n")
		expect(stored?.map((row) => row.recordHash)).toEqual(
			lines.map((line) => createHash("sha256").update(line).digest("hex")),
		)
		expect(posts().map((snapshot) => snapshot.revision)).toEqual(["1"])
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
		const frozen = await pendingFrozenSnapshots(directory, () => {}, Date.now() + 5000)
		const timedOut = frozen.find(({ entry }) => entry.revision === "1")?.entry
		expect(timedOut?.attempts).toBe(1)
		expect(timedOut?.retryAt).toBeGreaterThan(Date.now())
		expect(entry).toMatchObject({ revision: "1", attempts: 1 })
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
	it("cancels an in-flight upload when another instance opts out and retains its payload", async () => {
		const pending = JSON.stringify(Object.values((await readReportingState(directory)).entries)[0].pending)
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
		expect(JSON.stringify(Object.values(state.entries)[0].pending)).toBe(pending)
		expect(Object.values(state.entries)[0].requestHashes).toHaveLength(1)
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
	it("still delivers when the opt-out poller cannot start", async () => {
		vi.spyOn(fs, "watchFile").mockImplementation(() => {
			throw Object.assign(new Error("stat watcher unavailable"), { code: "ENOSPC" })
		})
		respond(accepted)
		await deliverSnapshots(directory, "/project", new AbortController().signal, () => {})
		expect(posts()).toHaveLength(1)
		expect(Object.values((await readReportingState(directory)).entries)[0].pending).toBeUndefined()
	})
	it("does not hold a directory watch during delivery", async () => {
		const watching = vi.spyOn(fs, "watch")
		const polling = vi.spyOn(fs, "watchFile")
		respond(accepted)
		await deliverSnapshots(directory, "/project", new AbortController().signal, () => {})
		expect(watching).not.toHaveBeenCalled()
		expect(polling).toHaveBeenCalledWith(
			expect.stringMatching(/pr-cost-reporting[\\/]state\.json$/),
			{ persistent: false, interval: 250 },
			expect.any(Function),
		)
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
	it("still delivers queued snapshots whose larger replacements do not fit the local queue", async () => {
		const ids = new Map(["51", "52", "53"].map((id) => [id, Array.from({ length: 32_000 }, () => crypto.randomUUID())]))
		const full = (bills: number) =>
			[...ids].map(([repositoryId, requestIds]) => {
				const value = inventory(requestIds, repositoryId)
				for (const request of value.content.requests)
					request.billingRecordIds = Array.from({ length: bills }, () => crypto.randomUUID())
				return value
			})
		await queueSnapshots(directory, [content, ...full(0)])
		// Two bills per request make every replacement too large to queue beside the snapshots already waiting.
		expect((await queueSnapshots(directory, [content, ...full(2)])).error).toContain(
			"until queued reports leave room in the local queue",
		)
		respond(accepted)
		// A 24 MiB queue can outlast one 5-second pass on a slow CI runner; this checks for a stall, not speed.
		await deliverSnapshots(directory, "/project", new AbortController().signal, () => {}, Date.now() + 50_000)
		// Delivering what is already queued is what frees the room; nothing may stall it.
		expect(posts().map((payload) => [payload.repository.id, payload.revision])).toEqual([
			["42", "1"],
			["51", "1"],
			["52", "1"],
		])
	}, 60_000)
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
	it("retains observed ordinary revisions during the five-minute window and then drains each", async () => {
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
			["2", 2],
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
/** Status items wrap with a two-column indent; reading them as prose keeps these checks about content. */
const unwrapped = (text: string) => text.replaceAll("\n  ", " ")
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
		expect(unwrapped(statusText(state, undefined).text)).toContain(
			"github.com repository 42: producer limit reached (repositories 101 of 100). Not reported; next try in about 6 h.",
		)
		http.mockClear()
		await deliver()
		expect(posts()).toEqual([])
	})
	it.each([
		["organization", "this organization"],
		["contributor", "your account in this organization"],
	])("pauses the whole account for a %s limit but still sends a withdrawal", async (scope, owner) => {
		await queueSnapshots(directory, [content, inventory([second], "43")])
		respond((payload) => (payload.requests.length ? limited(scope, "requests", "50000", "50000") : accepted(payload)))
		await deliver()
		expect(posts()).toHaveLength(1)
		const state = await readReportingState(directory)
		expect(Object.values(state.paused ?? {})).toMatchObject([{ limit: { scope, limit: "requests" } }])
		expect(unwrapped(statusText(state, undefined).text)).toContain(
			`PR cost reporting paused for ${owner}: ${scope} limit reached (requests 50,000 of 50,000). Ask an admin to free space or wait. Next try in about`,
		)
		// The request moves to repository 43, so repository 42 is withdrawn; the withdrawal frees space.
		http.mockClear()
		await queueSnapshots(directory, [inventory([second, requestId], "43")], true)
		await deliver()
		expect(posts().map((payload) => [payload.repository.id, payload.requests.length])).toEqual([["42", 0]])
		expect((await readReportingState(directory)).paused).toBeDefined()
	})
	it("does not pause the account for a limit the server reports only on queries", async () => {
		await queueSnapshots(directory, [content, inventory([second], "43")])
		respond((payload) =>
			payload.repository.id === "42" ? limited("frozen", "reports", "250001", "250000") : accepted(payload),
		)
		await deliver()
		// Frozen totals never reject an upload; an unknown scope waits on this repository alone.
		const state = await readReportingState(directory)
		expect(state.paused).toBeUndefined()
		expect(await entryFor("42")).toMatchObject({ limit: { current: 250001, maximum: 250000 } })
		expect((await entryFor("42"))?.limit?.scope).toBeUndefined()
		expect((await entryFor("43"))?.pending).toBeUndefined()
	})
	it("retains a rejected legacy body at cutover and retries its exact bytes after the limit wait", async () => {
		await queueSnapshots(directory, [inventory([requestId, second])])
		const original = JSON.stringify(Object.values((await readReportingState(directory)).entries)[0].pending)
		let full = true
		respond((payload) => (full ? limited("snapshot", "requests", "2", "1") : accepted(payload)))
		await deliver()
		const frozen = await pendingFrozenSnapshots(directory, () => {}, Date.now() + 5000)
		const rejected = frozen.find((row) => row.body === original)
		expect(rejected?.entry.limit).toMatchObject({ scope: "snapshot", limit: "requests" })
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(
			(await pendingFrozenSnapshots(directory, () => {}, Date.now() + 5000)).find((row) => row.id === rejected?.id)
				?.body,
		).toBe(original)
		full = false
		vi.spyOn(Date, "now").mockReturnValue((rejected?.entry.retryAt ?? 0) + LIMIT_RETRY_MS)
		await deliver()
		expect(
			http.mock.calls
				.filter(([url]) => String(url).endsWith("pr-cost-snapshots"))
				.some(([, init]) => init?.body === original),
		).toBe(true)
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
		vi.spyOn(providerApi, "lookupRepositoryIdentity").mockRejectedValue(new LookupError(message, kind))
		respond(accepted)
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		const identities = vi.mocked(eventBuilder.buildEvents).mock.calls.at(-1)?.[2]
		expect(identities?.get("/scratch/.git")).toBe(complete ? "unsupported" : undefined)
		expect(posts()).toEqual([])
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
		const lookup = vi.spyOn(providerApi, "lookupRepositoryIdentity").mockImplementation((path, signal) =>
			path === "/private/repo/.git"
				? Promise.resolve({ ...content.content.repository, name: "example/repo" })
				: new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true })
					}),
		)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		expect(posts()).toHaveLength(1)
		await run()
		expect(lookup).toHaveBeenCalledTimes(2)
		const next = Date.now() + 31_000
		vi.spyOn(Date, "now").mockReturnValue(next)
		lookup.mockResolvedValue({ provider: "github", host: "github.com", name: "team/slow", id: "99" })
		await run()
		expect(lookup).toHaveBeenCalledTimes(3)
		expect(vi.mocked(eventBuilder.buildEvents).mock.calls.at(-1)?.[2].get("/slow/.git")).toMatchObject({ id: "99" })
	})
	it("keeps a repository identity for a day, then refreshes it", async () => {
		await seedLinked()
		const path = join(directory, "work-attribution", "source.jsonl")
		const rows = (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.filter((line) => JSON.parse(line).type !== "commit")
		await writeFile(path, `${rows.join("\n")}\n`)
		const lookup = vi.spyOn(providerApi, "lookupRepositoryIdentity").mockResolvedValue({
			provider: "github",
			host: "github.com",
			name: "team/first",
			id: "98",
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		await run()
		expect(lookup).toHaveBeenCalledOnce()
		const clock = vi.spyOn(Date, "now")
		const start = Date.now()
		// Passes run every 30 seconds; an hour of them asks the provider nothing.
		clock.mockReturnValue(start + 60 * 60_000)
		await run()
		expect(lookup).toHaveBeenCalledOnce()
		clock.mockReturnValue(start + 24 * 60 * 60_000)
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
		vi.spyOn(providerApi, "lookupRepositoryIdentity").mockImplementation(async (path) => {
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
		const queued = [...(vi.mocked(eventBuilder.buildEvents).mock.calls.at(-1)?.[2].values() ?? [])].filter(
			(entry) => entry !== "unsupported" && Number(entry.id) >= 1000,
		)
		expect(queued).toHaveLength(12)
		// One lookup per repository, plus at most one abandoned when a pass deadline interrupts it.
		expect(lookups).toBeLessThanOrEqual(13)
	}, 30_000)
})

describe("idle reporting passes", () => {
	it("performs no journal body reads on an unchanged idle pass", async () => {
		await seedLinked()
		respond(accepted)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		await run()
		const reads = vi.spyOn(fs, "readSync")
		await run()
		expect(reads).not.toHaveBeenCalled()
		expect(posts()).toHaveLength(1)
	})

	it.each([
		"new",
		"unknown",
	] as const)("drains a duplicate-only window before judging %s trailing evidence", async (kind) => {
		await seedLinked()
		respond(accepted)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		await run()
		const path = join(directory, "work-attribution", "source.jsonl")
		const duplicate = `${(await readFile(path, "utf8")).split("\n")[0]}\n`
		const duplicates = duplicate.repeat(Math.ceil((512 * 1024) / Buffer.byteLength(duplicate)) + 2)
		expect(Buffer.byteLength(duplicates)).toBeGreaterThan(512 * 1024)
		const tail = {
			version: 1,
			type: kind === "new" ? "request" : "future_retraction",
			workId: "55555555-5555-4555-8555-555555555555",
			sessionId: "private-session",
			requestId: "66666666-6666-4666-8666-666666666666",
			scope: null,
		}
		await appendFile(path, `${duplicates}${JSON.stringify(tail)}\n`)
		const calculate = vi.spyOn(costs, "calculatePullRequestCosts")
		await run()
		if (kind === "new") {
			expect(readRecords(directory)).toContainEqual(tail)
			expect(calculate).toHaveBeenCalledOnce()
		} else {
			const problems: summary.WorkRecordProblem[] = []
			reportJournalProblems(directory, (problem) => problems.push(problem))
			expect(problems).toContainEqual(expect.objectContaining({ kind: "unknown-type", record: tail }))
			expect(calculate).not.toHaveBeenCalled()
			expect((await readReportingState(directory)).error).toContain("complete inventory")
		}
		expect(posts()).toHaveLength(1)
	})

	it("rechecks changed legacy input after a recoverable torn append", async () => {
		await seedLinked()
		respond(accepted)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		await run()
		const path = join(directory, "work-attribution", "source.jsonl")
		const valid = (await readFile(path, "utf8")).split("\n")[0]
		const calculate = vi.spyOn(costs, "calculatePullRequestCosts")
		await appendFile(path, '{"type":"request"\n')
		await run()
		expect(calculate).not.toHaveBeenCalled()
		expect((await readReportingState(directory)).error).toContain("complete inventory")
		await appendFile(path, `${valid}\n`)
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000)
		await run()
		expect(calculate).toHaveBeenCalledOnce()
		expect((await readReportingState(directory)).error).toBeUndefined()
		const problems: summary.WorkRecordProblem[] = []
		reportJournalProblems(directory, (problem) => problems.push(problem))
		expect(problems).toEqual([])
		expect(posts()).toHaveLength(1)
	})

	it("skips an unchanged pass, reads journals in the background and refreshes mutable metadata", async () => {
		await seedLinked()
		respond(accepted)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		// The acknowledgement changed the queue, so the second pass captures once more.
		await run()
		const calculate = vi.spyOn(costs, "calculatePullRequestCosts")
		const blockingRead = vi.spyOn(summary, "readWorkRecords")
		await run()
		expect(calculate).not.toHaveBeenCalled()
		// Without new records, the upload window still moves within the hour.
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000)
		await run()
		expect(calculate).toHaveBeenCalledOnce()
		await appendFile(
			join(directory, "work-attribution", "source.jsonl"),
			`${JSON.stringify({ version: 1, type: "work", workId: "55555555-5555-4555-8555-555555555555", sessionId: "private-session", recordedAt: new Date().toISOString() })}\n`,
		)
		await run()
		expect(calculate).toHaveBeenCalledTimes(2)
		expect(blockingRead).not.toHaveBeenCalled()
		expect(posts()).toHaveLength(1)
	})
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
		expect(capturedReport()?.requests.map((row) => row.requestId)).toEqual([requestId])
		expect(posts()).toEqual([])
		expect((await readReportingState(directory)).error).toBeUndefined()
	})
	it("keeps reporting recorded work when another session's journal ends with a partial line", async () => {
		await rm(join(directory, "pr-cost-reporting", "state.json"))
		await seedLinked()
		// A process died during its final append; that record was never complete or reported.
		await writeFile(join(directory, "work-attribution", "crashed.jsonl"), '{"type":"request","requestId":"0b8f')
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(capturedReport()?.requests.map((row) => row.requestId)).toEqual([requestId])
		expect(posts()).toEqual([])
	})
})
