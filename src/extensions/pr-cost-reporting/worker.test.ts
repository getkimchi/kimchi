import type * as fs from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as outbox from "@getkimchi/kimchi-bridge/ledger"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type * as costs from "../work-attribution/costs.js"
import type * as summary from "../work-attribution/summary.js"
import { flushWorkSummaries } from "../work-attribution/summary.js"
import { pendingFrozenSnapshots, readPendingBody, readReportingState, setReportingEnabled } from "./queue.js"
import type { RepositorySnapshot, WireSnapshot } from "./snapshot.js"
import { statusText } from "./status.js"

/** The bridge worker's limit retry window (6 h); pinned here because the constant is not exported. */
const LIMIT_RETRY_MS = 6 * 3600_000

import { deliverSnapshots, queueSnapshots, reconcileReporting } from "@getkimchi/kimchi-bridge/reconcile"
import { installKimchiHostPorts } from "../work-attribution/host-ports.js"

const config = vi.hoisted(() => ({ key: "test-key", endpoint: "https://api.example" }))
vi.mock("node:fs", async (original) => ({ ...(await original<typeof fs>()) }))
// The bridge worker resolves credentials, consent and fetch through HostPorts; the
// config mock below feeds the in-process host the same test key and endpoint.
installKimchiHostPorts()
vi.mock("../work-attribution/costs.js", async (original) => ({ ...(await original<typeof costs>()) }))
// The prelude's cost report runs through costs-sync: transparent delegation,
// recorded, so the stretcher-sharing test can read the calls.
vi.mock("@getkimchi/kimchi-bridge/reconcile", async (original) => {
	const actual = await original<typeof import("@getkimchi/kimchi-bridge/reconcile")>()
	return { ...actual, readWorkCostReportAsync: vi.fn(actual.readWorkCostReportAsync) }
})
vi.mock("../work-attribution/summary.js", async (original) => ({ ...(await original<typeof summary>()) }))
vi.mock("@getkimchi/kimchi-bridge/ledger", async (original) => {
	// The global work-ledger setup installs the in-memory backend, but this file's own
	// barrel mock replaces it; re-seed it so Node (no bun:sqlite) runs the ledger too.
	const actual = await original<typeof outbox>()
	actual.useBackendFactory(() => actual.createMemoryRecords())
	return { ...actual }
})
// Pass-through timers: real macrotask semantics, with a call counter the tests can read.
vi.mock("node:timers/promises", async (original) => {
	const real = await original<typeof import("node:timers/promises")>()
	let calls = 0
	return {
		...real,
		setImmediate: (...args: Parameters<typeof real.setImmediate>) => {
			calls += 1
			return real.setImmediate(...args)
		},
		__calls: () => {
			const count = calls
			calls = 0
			return count
		},
	}
})
vi.mock("../../config.js", () => ({
	loadConfig: () => ({ apiKey: config.key }),
	resolveEndpoints: () => ({ platformApiUrl: config.endpoint }),
	readTelemetryConfig: () => ({ enabled: true }),
	readPrReportingConsent: () => undefined,
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
const deliver = () => deliverSnapshots(directory, "/project", new AbortController().signal, () => {})
const second = "55555555-5555-4555-8555-555555555551"
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
		expect(readPendingBody(directory, await entryFor("43"))).toBeUndefined()
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
		expect(readPendingBody(directory, await entryFor("43"))).toBeUndefined()
	})
	it("retains a rejected legacy body at cutover and retries its exact bytes after the limit wait", async () => {
		await queueSnapshots(directory, [inventory([requestId, second])])
		const original = JSON.stringify(
			readPendingBody(directory, Object.values((await readReportingState(directory)).entries)[0]),
		)
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
})
