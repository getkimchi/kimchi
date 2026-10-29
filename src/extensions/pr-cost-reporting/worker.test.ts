import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import * as providerApi from "../pull-request-status/provider-api.js"
import { LookupError } from "../pull-request-status/provider-records.js"
import { requestTagSelector } from "../work-attribution/billing-source.js"
import * as summary from "../work-attribution/summary.js"
import { flushWorkSummaries } from "../work-attribution/summary.js"
import { appendWorkRecord } from "../work-attribution.js"
import * as eventBuilder from "./events.js"
import { groupKey } from "./incremental.js"
import { reportJournalProblems } from "./ledger/import.js"
import * as outbox from "./ledger/outbox.js"
import { backendFor, readRecords } from "./ledger/records.js"
import { readReportingState, reportingStatePath, setReportingEnabled } from "./queue.js"
import { accountKey } from "./snapshot.js"
import { deliverEvents, LIMIT_RETRY_MS, reconcileReporting, retryDelay } from "./worker.js"

const config = vi.hoisted(() => ({ key: "test-key", endpoint: "https://api.example" }))
vi.mock("node:fs", async (original) => ({ ...(await original<typeof fs>()) }))
vi.mock("../work-attribution/summary.js", async (original) => ({ ...(await original<typeof summary>()) }))
vi.mock("./events.js", () => {
	const buildEvents = vi.fn<typeof eventBuilder.buildEvents>(() => ({ accounts: [], units: [], unresolved: [] }))
	return {
		buildEvents,
		buildEventsSteps: vi.fn(function* (...args: Parameters<typeof eventBuilder.buildEventsSteps>) {
			yield
			const [stored, report, repositories, producer, check, claim, touched] = args
			return buildEvents(stored, report, repositories, producer, check, claim, touched)
		}),
	}
})
// Node cannot encode real batches (protocol times need Temporal); the Bun ledger driver covers dispatch and ACKs.
vi.mock("./ledger/outbox.js", async (original) => {
	const real = await original<typeof outbox>()
	return {
		...real,
		observeEvents: vi.fn(),
		pendingBatch: vi.fn(),
		acknowledgeBatch: vi.fn(real.acknowledgeBatch),
	}
})
vi.mock("../../config.js", () => ({
	loadConfig: () => ({ apiKey: config.key }),
	resolveEndpoints: () => ({ platformApiUrl: config.endpoint }),
	readTelemetryConfig: () => ({ enabled: true }),
}))
const org = "11111111-1111-4111-8111-111111111111"
const user = "22222222-2222-4222-8222-222222222222"
const requestId = "33333333-3333-4333-8333-333333333333"
const account = { apiUrl: "https://api.example", organizationId: org, userId: user }
const repository = { provider: "github" as const, host: "github.com", id: "42" }
let directory: string
const http = vi.fn<typeof fetch>()
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "kimchi-reporting-http-"))
	vi.mocked(eventBuilder.buildEvents).mockClear()
	vi.mocked(outbox.observeEvents).mockClear()
	vi.mocked(outbox.pendingBatch).mockReset()
	vi.mocked(outbox.acknowledgeBatch).mockClear()
	config.key = "test-key"
	config.endpoint = "https://api.example"
	http.mockReset().mockImplementation(async () => Response.json({ organizationId: org, userId: user }))
	vi.stubGlobal("fetch", http)
	await setReportingEnabled(directory, true)
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	await rm(directory, { recursive: true, force: true })
})
const capturedReport = () => vi.mocked(eventBuilder.buildEvents).mock.calls.at(-1)?.[1]
/** Every request each connected group of works passed to the producer. */
const capturedRequests = () => vi.mocked(eventBuilder.buildEvents).mock.calls.flatMap(([, report]) => report.requests)
/** Counts completed captures from here on: each one prices the history and then builds its events once. */
const countCaptures = () => vi.mocked(eventBuilder.buildEvents).mockClear()
const deliver = () => deliverEvents(directory, "/project", new AbortController().signal, () => {})
/** A frozen batch that makes a pass authenticate; only its outbox row is read before the mocked freeze. */
function queueBatch(id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", accountId = accountKey(account)) {
	const batch = { id, accountKey: accountId, body: new Uint8Array(), eventIds: [], createdAt: Date.now(), orderKey: "" }
	backendFor(directory).insertOutboxBatch(batch)
	return batch
}
/** A queued batch that the mocked freeze hands to dispatch, so a pass uploads it. */
function sendableBatch() {
	const batch = queueBatch()
	vi.mocked(outbox.pendingBatch).mockReturnValue(batch)
	return batch
}
const retryNote = (accountId: string) =>
	JSON.parse(backendFor(directory).getNote("pr-cost-delivery", accountId) ?? "{}")
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
			scope: { account, repository: "/private/repo/.git" },
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
		await deliver()
		expect(http).not.toHaveBeenCalled()
	})
	it.each([
		"backoff",
		"explicit resume",
		"another eligible account",
	])("checks event schedules before authentication: %s", async (mode) => {
		const backend = backendFor(directory)
		const batch = queueBatch()
		backend.putNote(
			"pr-cost-delivery",
			batch.accountKey,
			JSON.stringify({
				batchId: batch.id,
				attempts: 1,
				retryAt: Date.now() + 60_000,
				resume: backend.getNote("agent", "legacy-snapshot-resume"),
			}),
		)
		if (mode === "explicit resume") await setReportingEnabled(directory, true)
		if (mode === "another eligible account") queueBatch("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "other-account")
		await deliver()
		expect(http).toHaveBeenCalledTimes(mode === "backoff" ? 0 : 1)
		if (mode !== "backoff") expect(String(http.mock.calls[0][0])).toContain("api-keys:verify")
	})

	// Lower bounds below the ±20% jitter: 4xx waits about an hour, a transient failure about 30 seconds.
	it.each([
		[401, 40 * 60_000],
		[503, 20_000],
	])("backs off an event account after a verification answered HTTP %i instead of verifying every pass", async (code, least) => {
		const batch = queueBatch()
		http.mockResolvedValue(new Response("{}", { status: code }))
		await deliver()
		await deliver()
		expect(http).toHaveBeenCalledOnce()
		const retry = retryNote(batch.accountKey)
		expect(retry).toMatchObject({ attempts: 1, error: `PR cost event upload returned HTTP ${code}` })
		expect(retry.retryAt - Date.now()).toBeGreaterThan(least)
	})

	it("uploads events with the SSO credential when no API key is configured", async () => {
		config.key = ""
		const agentDir = join(directory, "agent")
		await mkdir(agentDir, { recursive: true })
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ "kimchi-dev": { type: "oauth", access: "oauth-access", refresh: "r", orgId: org } }),
		)
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
		sendableBatch()
		await deliver()
		const upload = http.mock.calls.find(([url]) => String(url).endsWith("pr-cost-events:batchIngest"))
		const headers = new Headers(upload?.[1]?.headers)
		expect(headers.get("authorization")).toBe("Bearer oauth-access")
		expect(headers.get("x-castai-organization-id")).toBe(org)
	})

	it("keeps an event batch without an error when the credential changes during its upload", async () => {
		const batch = sendableBatch()
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

	it("sends a batch's events under a new ID after the server answers 409 for its ID", async () => {
		const batch = sendableBatch()
		http.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: new Response("{}", { status: 409 }),
		)
		await deliver()
		// The server holds other content under this ID, so resending the frozen batch could never succeed.
		expect(backendFor(directory).getOutboxBatch(batch.accountKey)).toBeUndefined()
		expect(retryNote(batch.accountKey)).toEqual({})
	})

	it("sends more than three batches in one pass, verifying the key once", async () => {
		const accountId = accountKey(account)
		const ids = [
			"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
		]
		const backend = backendFor(directory)
		for (const [order, id] of ids.entries())
			backend.insertOutboxBatch({
				id,
				accountKey: accountId,
				body: new Uint8Array(),
				eventIds: [],
				createdAt: Date.now(),
				orderKey: String(order),
			})
		vi.mocked(outbox.pendingBatch).mockImplementation((dir, key) =>
			dir === directory && key === accountId ? backend.getOutboxBatch(key) : undefined,
		)
		// Synthetic batches have no encodable body, so the acknowledgement drops the row instead of replaying it.
		vi.mocked(outbox.acknowledgeBatch).mockImplementation((_dir, key, sent) => {
			backend.deleteOutboxBatch(key, sent.id)
			return true
		})
		http.mockImplementation(async (input) => {
			if (String(input).endsWith("api-keys:verify")) return Response.json({ organizationId: org, userId: user })
			const ingestCount = http.mock.calls.filter(([url]) => String(url).includes("batchIngest")).length
			return Response.json({ batchId: ids[ingestCount - 1], receipts: [] })
		})
		await deliver()
		const calls = http.mock.calls.map(([input]) => String(input))
		expect(calls.filter((url) => url.endsWith("api-keys:verify"))).toHaveLength(1)
		expect(calls.filter((url) => url.includes("batchIngest"))).toHaveLength(4)
		expect(backend.getOutboxBatch(accountId)).toBeUndefined()
		expect(retryNote(accountId)).toEqual({})
	})

	it("queues the producer's facts and original hashes under their original account", async () => {
		await seedLinked(false)
		const group = {
			account,
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
		const units = [{ account: accountKey(account), entities: ["work"], recordHashes: group.recordHashes }]
		vi.mocked(eventBuilder.buildEvents).mockReturnValueOnce({ accounts: [group], units, unresolved: [] })
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(outbox.observeEvents).toHaveBeenCalledWith(
			directory,
			accountKey(account),
			group.facts,
			[],
			expect.any(Function),
		)
		// The group's records count as translated once its events commit.
		expect(backendFor(directory).markedRecords()).toEqual([])
		expect(
			vi
				.mocked(eventBuilder.buildEvents)
				.mock.calls.at(-1)?.[0]
				.map((row) => JSON.parse(row.body)),
		).toEqual(readRecords(directory))
	})

	it("captures work before a PR exists and captures its later PR", async () => {
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
		vi.spyOn(providerApi, "lookupRepositoryIdentity").mockResolvedValue({ ...repository, name: "example/repo" })
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		expect(capturedReport()?.requests[0]).toMatchObject({ requestId, pullRequestIds: [] })
		const firstProducer = vi.mocked(eventBuilder.buildEvents).mock.calls.at(-1)?.[3]
		await writeFile(path, linked)
		await run()
		expect(capturedReport()?.requests[0].pullRequestIds).toHaveLength(1)
		expect(capturedReport()?.pullRequests[0].pullRequest).toMatchObject({ id: "101", repositoryId: "42" })
		expect(vi.mocked(eventBuilder.buildEvents).mock.calls.at(-1)?.[3]).toBe(firstProducer)
		// Import changes the authority fingerprint; one following pass catches up to that prefix.
		await run()
		const captures = vi.mocked(eventBuilder.buildEvents).mock.calls.length
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(captures)
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
		expect((await readReportingState(directory)).error).toBeUndefined()
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
		expect(capturedRequests().find((row) => row.requestId === requestId)?.account).toEqual(account)
		expect(
			capturedRequests().find((row) => row.requestId === "77777777-7777-4777-8777-777777777777")?.account,
		).toBeNull()
		expect(
			vi.mocked(eventBuilder.buildEvents).mock.calls.flatMap(([stored]) => stored.map((row) => JSON.parse(row.body))),
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
		expect(capturedRequests().find((row) => row.requestId === healthyId)?.account).toEqual(account)
		expect(capturedRequests().find((row) => row.requestId === requestId)?.account).toBeNull()
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
	})
	it("cancels an in-flight request when another instance opts out", async () => {
		queueBatch()
		let sent: (() => void) | undefined
		const sending = new Promise<void>((resolve) => {
			sent = resolve
		})
		http.mockImplementation(async (_input, init) => {
			sent?.()
			return new Promise((_resolve, reject) =>
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
			)
		})
		const running = deliver()
		await sending
		await setReportingEnabled(directory, false)
		await expect(running).rejects.toThrow()
		expect(backendFor(directory).getOutboxBatch(accountKey(account))).toBeDefined()
		// An opt-out is not a failed verification: nothing waits on a backoff once reporting is back on.
		expect(retryNote(accountKey(account))).toEqual({})
	})
	it("explains a role that cannot upload and retries the batch slowly", async () => {
		const batch = sendableBatch()
		http.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: Response.json({ message: "permission denied" }, { status: 403 }),
		)
		const before = Date.now()
		await deliver()
		const role =
			"PR reporting is not allowed for this API key: uploading PR costs needs an Owner or Member role (HTTP 403)"
		expect((await readReportingState(directory)).error).toBe(role)
		const retry = retryNote(batch.accountKey)
		expect(retry).toMatchObject({ batchId: batch.id, attempts: 1, error: role })
		expect(retry.retryAt - before).toBeGreaterThanOrEqual(0.8 * 60 * 60 * 1000)
	})
	it("stops reading a response after 64 KiB and keeps the batch for retry", async () => {
		const batch = sendableBatch()
		let read = 0
		http.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: new Response(
						new ReadableStream({
							pull(controller) {
								read += 16 * 1024
								controller.enqueue(new Uint8Array(16 * 1024))
								if (read >= 1024 * 1024) controller.close()
							},
						}),
					),
		)
		await deliver()
		expect(read).toBeLessThanOrEqual(128 * 1024)
		expect(retryNote(batch.accountKey)).toMatchObject({ batchId: batch.id, attempts: 1 })
	})
	it("does not upload after the configured endpoint changes during the pass", async () => {
		const batch = sendableBatch()
		http.mockImplementation(async () => {
			config.endpoint = "https://other.example"
			return Response.json({ organizationId: org, userId: user })
		})
		await expect(deliver()).rejects.toThrow()
		expect(http).toHaveBeenCalledOnce()
		expect(backendFor(directory).getOutboxBatch(batch.accountKey)?.id).toBe(batch.id)
		expect(retryNote(batch.accountKey)).toEqual({})
	})
	it("still delivers when the opt-out poller cannot start", async () => {
		vi.spyOn(fs, "watchFile").mockImplementation(() => {
			throw Object.assign(new Error("stat watcher unavailable"), { code: "ENOSPC" })
		})
		queueBatch()
		await deliver()
		expect(String(http.mock.calls[0]?.[0])).toContain("api-keys:verify")
		expect(outbox.pendingBatch).toHaveBeenCalled()
	})
	it("does not hold a directory watch during delivery", async () => {
		const watching = vi.spyOn(fs, "watch")
		const polling = vi.spyOn(fs, "watchFile")
		await deliver()
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
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect((await readReportingState(directory)).error).toContain("could not capture a complete inventory")
	})
	it("leaves an older version's pending snapshot on disk without sending it", async () => {
		await seedLinked()
		const path = reportingStatePath(directory)
		const pending = { schemaVersion: 1, revision: "1", repository, requests: [{ requestId }] }
		const saved = JSON.parse(await readFile(path, "utf8"))
		await writeFile(path, JSON.stringify({ ...saved, entries: { "older-repository": { account, pending } } }))
		queueBatch()
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		// The pass reaches authentication, but only an event batch can be sent.
		expect(http.mock.calls.map(([input]) => String(input))).toEqual([
			"https://api.example/ai-optimizer/v1beta/api-keys:verify",
		])
		expect(JSON.parse(await readFile(path, "utf8")).entries).toEqual({ "older-repository": { account, pending } })
	})
})

describe("event retry delays", () => {
	// Other 4xx responses, such as an endpoint that is not deployed yet, cannot be fixed by retrying.
	it.each([404, 400, 403])("backs off for hours after a permanent HTTP %s rejection", (status) => {
		vi.spyOn(Math, "random").mockReturnValue(0.5)
		expect([0, 1, 2, 3].map((attempts) => retryDelay(status, attempts, null) / 60_000)).toEqual([60, 120, 240, 360])
	})
	it.each([
		[0, 48],
		[0.999, 72],
	])("spreads a rejection's retry by 20%% so rejected clients do not return together (random %s)", (random, minutes) => {
		vi.spyOn(Math, "random").mockReturnValue(random)
		expect(Math.round(retryDelay(404, 0, null) / 60_000)).toBe(minutes)
	})
	it.each([408, 503])("keeps retrying HTTP %s within a minute", (status) => {
		expect(retryDelay(status, 0, null)).toBeLessThanOrEqual(60_000)
	})
	it("retries a 429 like an outage, backing off with jitter", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5)
		expect([0, 1, 2, 3].map((attempts) => retryDelay(429, attempts, null) / 1000)).toEqual([30, 60, 120, 240])
	})
	it("honors Retry-After between 30 seconds and six hours", () => {
		expect(retryDelay(429, 0, 120_000)).toBe(120_000)
		expect(retryDelay(503, 0, 1000)).toBe(30_000)
		expect(retryDelay(503, 0, 172_800_000)).toBe(LIMIT_RETRY_MS)
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
				scope: { account, repository: "/scratch/.git" },
			})}\n`,
		)
		vi.spyOn(providerApi, "lookupRepositoryIdentity").mockRejectedValue(new LookupError(message, kind))
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		const identities = vi.mocked(eventBuilder.buildEvents).mock.calls.at(-1)?.[2]
		expect(identities?.get("/scratch/.git")).toBe(complete ? "unsupported" : undefined)
	})
	it("keeps a known repository while another lookup times out, then retries that lookup after cooldown", async () => {
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
				scope: { account, repository: "/slow/.git" },
			})}\n`,
		)
		const lookup = vi.spyOn(providerApi, "lookupRepositoryIdentity").mockImplementation((path, signal) =>
			path === "/private/repo/.git"
				? Promise.resolve({ ...repository, name: "example/repo" })
				: new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true })
					}),
		)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		// Each group of works builds with its own repositories.
		const identities = new Map(vi.mocked(eventBuilder.buildEvents).mock.calls.flatMap(([, , known]) => [...known]))
		expect(identities.get("/private/repo/.git")).toMatchObject({ id: "42" })
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
		// Unchanged work needs no identity; its next record rebuilds it with a fresh one.
		expect(lookup).toHaveBeenCalledOnce()
		const [first] = rows.map((line) => JSON.parse(line))
		await appendFile(path, `${JSON.stringify({ ...first, type: "work", recordedAt: new Date().toISOString() })}\n`)
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
			scope: { account, repository: `/src/repo-${index}/.git` },
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
		const identities = vi
			.mocked(eventBuilder.buildEvents)
			.mock.calls.flatMap(([, , repositories]) => [...repositories.values()])
		const queued = new Set(
			identities.flatMap((entry) => (entry !== "unsupported" && Number(entry.id) >= 1000 ? [entry.id] : [])),
		)
		expect(queued.size).toBe(12)
		// One lookup per repository, plus at most one abandoned when a pass deadline interrupts it.
		expect(lookups).toBeLessThanOrEqual(13)
	}, 30_000)
})

describe("incremental translation", () => {
	it("commits events in chunks, so a pass that runs out of time resumes where it stopped", async () => {
		await seedLinked()
		const key = accountKey(account)
		const entities = Array.from({ length: 250 }, (_, index) => `entity-${index}`)
		const facts = entities.map((entityId) => ({
			entityId,
			source: "kimchi",
			sourceVersion: "test",
			deviceId: requestId,
			observeTime: "2026-10-04T12:00:00Z",
			coverage: { code: "fixture", count: "1" },
		}))
		vi.mocked(eventBuilder.buildEvents).mockReturnValue({
			accounts: [{ account, facts, recordHashes: [] }],
			units: entities.map((entity) => ({ account: key, entities: [entity], recordHashes: [] })),
			unresolved: [],
		})
		const clock = vi.spyOn(Date, "now")
		const start = Date.now()
		// The first chunk leaves the pass without time for another.
		vi.mocked(outbox.observeEvents).mockImplementationOnce(() => {
			clock.mockReturnValue(start + 4_800)
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		const observed = () =>
			vi.mocked(outbox.observeEvents).mock.calls.flatMap(([, , list]) => list.map((fact) => fact.entityId))
		expect(observed()).toEqual(entities.slice(0, 100))
		expect(backendFor(directory).markedRecords()).not.toEqual([])
		expect((await readReportingState(directory)).error).toBeUndefined()
		clock.mockRestore()
		await run()
		expect(observed()).toEqual(entities)
		expect(backendFor(directory).markedRecords()).toEqual([])
	})

	it("advances a later group before retrying a timed-out group without replaying committed chunks", async () => {
		await seedLinked()
		const path = join(directory, "work-attribution", "source.jsonl")
		const smallWork = "66666666-6666-4666-8666-666666666666"
		await appendFile(
			path,
			`${JSON.stringify({ version: 1, workId: smallWork, sessionId: "small", type: "work", recordedAt: "2026-10-04T12:00:00.000Z" })}\n`,
		)
		const key = accountKey(account)
		const large = Array.from({ length: 250 }, (_, index) => `large-${index}`)
		const facts = large.map((entityId) => ({
			entityId,
			source: "kimchi",
			sourceVersion: "test",
			deviceId: requestId,
			observeTime: "2026-10-04T12:00:00Z",
			coverage: { code: "fixture", count: "1" },
		}))
		vi.mocked(eventBuilder.buildEvents).mockImplementation((stored) =>
			stored[0]?.workId === smallWork
				? { accounts: [], units: [], unresolved: [] }
				: {
						accounts: [{ account, facts, recordHashes: [] }],
						units: large.map((entity) => ({ account: key, entities: [entity], recordHashes: [] })),
						unresolved: [],
					},
		)
		const clock = vi.spyOn(Date, "now")
		const start = Date.now()
		vi.mocked(outbox.observeEvents).mockImplementationOnce(() => clock.mockReturnValue(start + 4_800))
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		expect(
			backendFor(directory)
				.markedRecords()
				.some((row) => row.workId === smallWork),
		).toBe(true)
		clock.mockRestore()
		vi.mocked(eventBuilder.buildEvents).mockClear()
		await run()
		expect(vi.mocked(eventBuilder.buildEvents).mock.calls[0]?.[0][0]?.workId).toBe(smallWork)
		expect(backendFor(directory).markedRecords()).toEqual([])
		const observed = vi
			.mocked(outbox.observeEvents)
			.mock.calls.flatMap(([, , list]) => list.map((fact) => fact.entityId))
		expect(observed).toEqual(large)
	})

	it("starts with an unattempted group after the reserve is reached by an unsettled group", async () => {
		await seedLinked()
		const smallWork = "66666666-6666-4666-8666-666666666666"
		await appendFile(
			join(directory, "work-attribution", "source.jsonl"),
			`${JSON.stringify({ version: 1, workId: smallWork, sessionId: "small", type: "work", recordedAt: "2026-10-04T12:00:00.000Z" })}\n`,
		)
		vi.spyOn(providerApi, "lookupRepositoryIdentity").mockRejectedValue(new Error("offline"))
		const clock = vi.spyOn(Date, "now")
		const start = Date.now()
		vi.mocked(eventBuilder.buildEvents).mockImplementationOnce(() => {
			clock.mockReturnValue(start + 4_800)
			return { accounts: [], units: [], unresolved: [] }
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		expect(
			backendFor(directory)
				.markedRecords()
				.some((row) => row.workId === smallWork),
		).toBe(true)
		clock.mockRestore()
		vi.mocked(eventBuilder.buildEvents).mockClear()
		await run()
		expect(vi.mocked(eventBuilder.buildEvents).mock.calls[0]?.[0][0]?.workId).toBe(smallWork)
	})

	it("clears settled markers in the transaction that observes the final event chunk", async () => {
		await seedLinked()
		const backend = backendFor(directory)
		const key = accountKey(account)
		const fact = {
			entityId: "final-event",
			source: "kimchi",
			sourceVersion: "test",
			deviceId: requestId,
			observeTime: "2026-10-04T12:00:00Z",
			coverage: { code: "fixture", count: "1" },
		}
		vi.mocked(eventBuilder.buildEvents).mockReturnValue({
			accounts: [{ account, facts: [fact], recordHashes: [] }],
			units: [{ account: key, entities: [fact.entityId], recordHashes: [] }],
			unresolved: [],
		})
		const tx = backend.tx
		let sequence = 0
		let active = 0
		const observed: number[] = []
		const cleared: number[] = []
		vi.spyOn(backend, "tx").mockImplementation((fn) => {
			const previous = active
			active = ++sequence
			try {
				return tx(fn)
			} finally {
				active = previous
			}
		})
		vi.mocked(outbox.observeEvents).mockImplementationOnce(() => observed.push(active))
		const clear = backend.clearTranslation
		vi.spyOn(backend, "clearTranslation").mockImplementation((hash) => {
			cleared.push(active)
			clear(hash)
		})
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(observed).toHaveLength(1)
		expect(cleared.length).toBeGreaterThan(0)
		expect(new Set(cleared)).toEqual(new Set(observed))
		expect(backend.markedRecords()).toEqual([])
	})

	it("reads only new request evidence after a group has caught up", async () => {
		await seedLinked()
		// This suite mocks the builder; return complete request units so it can persist a complete group projection.
		vi.mocked(eventBuilder.buildEvents).mockImplementation(
			(_stored, report, _repos, _producer, _check, _claim, touched) => {
				const selected = report.requests.filter((request) => !touched || touched.requests.has(request.requestId))
				return {
					accounts: [
						{
							account,
							facts: selected.map((request) => ({
								entityId: request.requestId,
								source: "kimchi" as const,
								sourceVersion: "test",
								deviceId: request.requestId,
								observeTime: "2026-10-04T12:00:00Z",
								coverage: { code: "fixture", count: "1" },
							})),
							recordHashes: [],
						},
					],
					units: selected.map((request) => ({
						account: accountKey(account),
						requestId: request.requestId,
						entities: [request.requestId],
						recordHashes: [],
					})),
					unresolved: [],
				}
			},
		)
		const path = join(directory, "work-attribution", "source.jsonl")
		const workId = "55555555-5555-4555-8555-555555555555"
		const request = (index: number) => ({
			version: 1,
			type: "request",
			workId,
			sessionId: "lumbrook-session",
			requestId: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
			recordedAt: "2026-10-04T12:00:00.000Z",
			startedAt: "2026-10-04T12:00:00.000Z",
			scope: { account, repository: "/private/repo/.git" },
		})
		await appendFile(path, `${Array.from({ length: 200 }, (_, index) => JSON.stringify(request(index))).join("\n")}\n`)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		expect(backendFor(directory).markedRecords()).toEqual([])
		await appendFile(path, `${JSON.stringify(request(200))}\n`)
		const backend = backendFor(directory)
		const read = backend.readRecords
		let workRows = 0
		vi.spyOn(backend, "readRecords").mockImplementation((opts, checkBudget) => {
			const rows = read(opts, checkBudget)
			if (opts.workId === workId) workRows += rows.length
			return rows
		})
		await run()
		expect(workRows).toBeLessThanOrEqual(8)

		// A v1.22 ledger has no derived group note; rebuild it once, then use only new evidence again.
		backend.deleteNote("agent", groupKey([workId]))
		await appendFile(path, `${JSON.stringify(request(201))}\n`)
		await run()
		expect(backend.getNote("agent", groupKey([workId]))).toBeDefined()
		await appendFile(path, `${JSON.stringify(request(202))}\n`)
		workRows = 0
		await run()
		expect(workRows).toBeLessThanOrEqual(8)

		// File evidence can change attribution for earlier requests even without a new request row.
		await appendFile(
			path,
			`${JSON.stringify({ version: 1, type: "file_transition", workId, sessionId: "lumbrook-session", transitionId: "later-edit", toolCallId: "edit", repository: "/private/repo/.git", worktree: "/private/repo", path: "src/lumbrook.ts", before: null, after: { blob: "a".repeat(40), mode: "100644" }, recordedAt: "2026-10-04T12:00:00.000Z" })}\n`,
		)
		workRows = 0
		await run()
		expect(workRows).toBeGreaterThan(8)
		expect(backend.getNote("agent", groupKey([workId]))).toBeDefined()

		const beforeObservation = backend.recordCount(workId)
		const observation = {
			version: 1,
			type: "file_observation",
			workId,
			sessionId: "lumbrook-session",
			requestId: request(203).requestId,
			observationId: "lumbrook-incomplete-scan",
			toolCallId: "read",
			source: "bash",
			repository: "/private/repo/.git",
			worktree: "/private/repo",
			startedAt: "2026-10-04T12:00:00.000Z",
			recordedAt: "2026-10-04T12:00:00.000Z",
			complete: false,
			files: [],
			reason: "incomplete-snapshot",
		}
		await appendFile(path, `${JSON.stringify(request(203))}\n${JSON.stringify(observation)}\n`)
		workRows = 0
		await run()
		expect(backend.recordCount(workId)).toBe(beforeObservation + 2)
		expect(workRows).toBeGreaterThan(8)
	})

	it("rebuilds only the group of works whose records changed", async () => {
		await seedLinked()
		const path = join(directory, "work-attribution", "source.jsonl")
		const other = { version: 1, workId: "66666666-6666-4666-8666-666666666666", sessionId: "other-session" }
		await appendFile(
			path,
			`${JSON.stringify({ ...other, type: "request", requestId: "77777777-7777-4777-8777-777777777777", startedAt: "2026-10-04T12:00:00.000Z", recordedAt: "2026-10-04T12:00:00.000Z", scope: { account, repository: "/other/.git" } })}\n`,
		)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(2)
		vi.mocked(eventBuilder.buildEvents).mockClear()
		await appendFile(path, `${JSON.stringify({ ...other, type: "work", recordedAt: new Date().toISOString() })}\n`)
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledOnce()
		const [stored] = vi.mocked(eventBuilder.buildEvents).mock.calls[0]
		expect(new Set(stored.map((row) => JSON.parse(row.body).workId))).toEqual(new Set([other.workId]))
	})
	it("yields during a large group build without clearing markers before it completes", async () => {
		await seedLinked()
		const workId = "55555555-5555-4555-8555-555555555555"
		const at = "2026-10-04T12:00:00.000Z"
		const rows = Array.from({ length: 1001 }, (_, index) => ({
			version: 1,
			type: "request",
			workId,
			sessionId: "private-session",
			requestId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			startedAt: at,
			recordedAt: at,
			scope: { account, repository: "/private/repo/.git" },
		}))
		await appendFile(
			join(directory, "work-attribution", "source.jsonl"),
			`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		)
		const backend = backendFor(directory)
		let eventLoopTurn = false
		vi.mocked(eventBuilder.buildEventsSteps).mockImplementationOnce(function* (...args) {
			setImmediate(() => {
				eventLoopTurn = true
			})
			for (let index = 0; index < 500_000; index++) yield
			expect(eventLoopTurn).toBe(true)
			expect(backend.markedRecords().length).toBeGreaterThan(0)
			const [stored, report, repositories, producer, check, claim, touched] = args
			return eventBuilder.buildEvents(stored, report, repositories, producer, check, claim, touched)
		})
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(eventBuilder.buildEvents).toHaveBeenCalledOnce()
		expect(backend.markedRecords()).toEqual([])
	})
})

describe("idle reporting passes", () => {
	it("performs no journal body reads on an unchanged idle pass", async () => {
		await seedLinked()
		const settled = new Date(Date.now() - 60_000)
		fs.utimesSync(join(directory, "work-attribution", "source.jsonl"), settled, settled)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		await run()
		const reads = vi.spyOn(fs, "readSync")
		await run()
		expect(reads).not.toHaveBeenCalled()
	})

	it.each([
		"new",
		"unknown",
	] as const)("drains a duplicate-only window before judging %s trailing evidence", async (kind) => {
		await seedLinked()
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
		const captures = countCaptures()
		await run()
		if (kind === "new") {
			expect(readRecords(directory)).toContainEqual(tail)
			expect(captures).toHaveBeenCalledOnce()
		} else {
			const problems: summary.WorkRecordProblem[] = []
			reportJournalProblems(directory, (problem) => problems.push(problem))
			expect(problems).toContainEqual(expect.objectContaining({ kind: "unknown-type", record: tail }))
			expect(captures).not.toHaveBeenCalled()
			expect((await readReportingState(directory)).error).toContain("complete inventory")
		}
	})

	it("rechecks changed legacy input after a recoverable torn append", async () => {
		await seedLinked()
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		await run()
		const path = join(directory, "work-attribution", "source.jsonl")
		const valid = (await readFile(path, "utf8")).split("\n")[0]
		const captures = countCaptures()
		await appendFile(path, '{"type":"request"\n')
		await run()
		expect(captures).not.toHaveBeenCalled()
		expect((await readReportingState(directory)).error).toContain("complete inventory")
		await appendFile(path, `${JSON.stringify({ ...JSON.parse(valid), recordedAt: new Date().toISOString() })}\n`)
		await run()
		expect(captures).toHaveBeenCalledOnce()
		expect((await readReportingState(directory)).error).toBeUndefined()
		const problems: summary.WorkRecordProblem[] = []
		reportJournalProblems(directory, (problem) => problems.push(problem))
		expect(problems).toEqual([])
	})

	it("skips unchanged passes, reads journals in the background and translates only new records", async () => {
		await seedLinked()
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		await run()
		const captures = countCaptures()
		const blockingRead = vi.spyOn(summary, "readWorkRecords")
		await run()
		expect(captures).not.toHaveBeenCalled()
		// Translated records stay translated: an hour later, without new records, nothing is rebuilt.
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000)
		await run()
		expect(captures).not.toHaveBeenCalled()
		await appendFile(
			join(directory, "work-attribution", "source.jsonl"),
			`${JSON.stringify({ version: 1, type: "work", workId: "55555555-5555-4555-8555-555555555555", sessionId: "private-session", recordedAt: new Date().toISOString() })}\n`,
		)
		await run()
		expect(captures).toHaveBeenCalledOnce()
		expect(blockingRead).not.toHaveBeenCalled()
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
		expect((await readReportingState(directory)).error).toBeUndefined()
	})
	it("keeps reporting recorded work when another session's journal ends with a partial line", async () => {
		await rm(join(directory, "pr-cost-reporting", "state.json"))
		await seedLinked()
		// A process died during its final append; that record was never complete or reported.
		await writeFile(join(directory, "work-attribution", "crashed.jsonl"), '{"type":"request","requestId":"0b8f')
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(capturedReport()?.requests.map((row) => row.requestId)).toEqual([requestId])
	})
})
