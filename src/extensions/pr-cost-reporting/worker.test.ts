import type * as fs from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as outbox from "@getkimchi/kimchi-bridge/ledger"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type * as costs from "../work-attribution/costs.js"
import type * as summary from "../work-attribution/summary.js"
import { flushWorkSummaries } from "../work-attribution/summary.js"
import {
	pendingFrozenSnapshots,
	queueSnapshots,
	readPendingBody,
	readReportingState,
	setReportingEnabled,
} from "./queue.js"
import type { RepositorySnapshot, WireSnapshot } from "./snapshot.js"
import { statusText } from "./status.js"
/** The bridge worker's limit retry window (6 h); pinned here because the constant is not exported. */
const LIMIT_RETRY_MS = 6 * 3600_000

import { deliverSnapshots, reconcileReporting } from "@getkimchi/kimchi-bridge/reconcile"
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
<<<<<<< HEAD
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
		// The group with the unresolved identity waits out its retry window before looking up again.
		const next = Date.now() + 5 * 60_000 + 1_000
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

describe("prelude stretching of a big group", () => {
	it("pages each work's records instead of materializing the whole work at once", async () => {
		await seedLinked()
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({
			accounts: [],
			units: [],
			unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
		})
		const backend = backendFor(directory)
		const pagedRead = vi.spyOn(backend, "readWorkRecordPage")
		const wholeRead = vi.spyOn(backend, "readRecords")
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		// A second work with 300 records: the translation prelude must cross a 128-row page
		// boundary reading it, and must never fall back to the whole-work synchronous read.
		const source = join(directory, "work-attribution", "source.jsonl")
		const work = "65656565-6565-4565-8565-656565656565"
		let lines = ""
		for (let index = 0; index < 300; index++) {
			const hex = String(index).padStart(12, "0")
			lines += `${JSON.stringify({
				version: 1,
				type: "request",
				workId: work,
				sessionId: "records-only",
				requestId: `${hex.slice(0, 8)}-${hex.slice(8)}-4777-8777-${hex}`,
				startedAt: "2026-10-04T12:00:00.000Z",
				recordedAt: "2026-10-04T12:00:00.000Z",
				scope: { account: "10101010-1010-4101-8101-101010101010", repository: "/other/.git" },
			})}\n`
		}
		await appendFile(source, lines)
		await run()
		// The paged per-work read ran, capped at 128 rows a page...
		expect(pagedRead.mock.calls.length).toBeGreaterThan(0)
		for (const call of pagedRead.mock.calls) expect(call[3]).toBe(128)
		// ...and crossed a boundary for the 300-record work (at least 3 pages).
		// (The projection rebuild still reads whole works synchronously inside its
		// transaction — a separate, out-of-scope path.)
		const pagesForBigWork = pagedRead.mock.calls.filter((call) => call[0] === work)
		expect(pagesForBigWork.length).toBeGreaterThanOrEqual(3)
		pagedRead.mockRestore()
		wholeRead.mockRestore()
	})

	it("the cost report shares the prelude's stretcher with the event translation", async () => {
		await seedLinked()
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({
			accounts: [],
			units: [],
			unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
		})
		// A second work with records only: its pending translation drives the reporting
		// prelude through the paged read and the cost report call.
		const source = join(directory, "work-attribution", "source.jsonl")
		const work = "75757575-7575-4575-8575-757575757575"
		let lines = ""
		for (let index = 0; index < 3; index++) {
			const hex = String(index).padStart(12, "0")
			lines += `${JSON.stringify({
				version: 1,
				type: "request",
				workId: work,
				sessionId: "records-only",
				requestId: `${hex.slice(0, 8)}-${hex.slice(8)}-4777-8777-${hex}`,
				startedAt: "2026-10-04T12:00:00.000Z",
				recordedAt: "2026-10-04T12:00:00.000Z",
				scope: { account: "10101010-1010-4101-8101-101010101010", repository: "/other/.git" },
			})}\n`
		}
		await appendFile(source, lines)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		const costSync = (await import("../work-attribution/cost-sync.js")) as unknown as {
			readWorkCostReportAsync: { mock: { calls: unknown[][] } }
		}
		const reportStretch = costSync.readWorkCostReportAsync.mock.calls.at(-1)?.[1] as (() => Promise<void>) | undefined
		// The translation's stretcher is buildEvents' last parameter.
		const eventsStretch = vi.mocked(eventBuilder.buildEvents).mock.calls.at(-1)?.at(-1) as
			| (() => Promise<void>)
			| undefined
		expect(typeof reportStretch).toBe("function")
		expect(reportStretch).toBe(eventsStretch)
	})

	it("crossing the row budget yields in the prelude's read and parse loops", async () => {
		await seedLinked()
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({
			accounts: [],
			units: [],
			unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
		})
		const calls = () => (timers as unknown as { __calls: () => number }).__calls()
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		calls()
		// Two structurally identical passes, each introducing exactly one new marker batch for the same
		// work: a 1-row pass, then a 2,000-row pass. The 2,001 rows total cross the shared row budget
		// and the pass machinery fires the same immediates in both phases: with identical surroundings,
		// at least two extra immediates appear only because the stretcher parked the loop somewhere in
		// the read and parse walks — a directional binding, since the floor can't see WHICH loop each
		// yield came from (loop-level floors live in events.test and links.test).
		const source = join(directory, "work-attribution", "source.jsonl")
		const work = "65656565-6565-4565-8565-656565656565"
		const rows = (count: number, offset: number) => {
			let lines = ""
			for (let index = offset; index < offset + count; index++) {
				const hex = String(index).padStart(12, "0")
				lines += `${JSON.stringify({
					version: 1,
					type: "request",
					workId: work,
					sessionId: "records-only",
					requestId: `${hex.slice(0, 8)}-${hex.slice(8)}-4777-8777-${hex}`,
					startedAt: "2026-10-04T12:00:00.000Z",
					recordedAt: "2026-10-04T12:00:00.000Z",
					scope: { account: content.account, repository: "/other/.git" },
				})}\n`
			}
			return lines
		}
		await appendFile(source, rows(1, 0))
		await run()
		const small = calls()
		await appendFile(source, rows(2_000, 1))
		await run()
		expect(calls()).toBeGreaterThanOrEqual(small + 2)
	})
})

describe("prelude stretch", () => {
	/** A stretch call that yields runs every already-scheduled macrotask first; a fast one leaves them parked. */
	const yielded = async (stretch: () => Promise<void>) => {
		let ran = false
		const timer = setImmediate(() => {
			ran = true
		})
		try {
			await stretch()
		} finally {
			clearImmediate(timer)
		}
		return ran
	}

	it("yields after the row budget, and after the time budget even for few rows", async () => {
		const stretch = preludeStretch(2, 60_000)
		expect(await yielded(stretch)).toBe(false)
		expect(await yielded(stretch)).toBe(true)
		expect(await yielded(stretch)).toBe(false)

		const slow = preludeStretch(10_000, 60_000)
		const clock = vi.spyOn(Date, "now")
		try {
			// One row but the stretch has already owned the loop past its time budget.
			clock.mockReturnValue(Date.now() + 60_001)
			expect(await yielded(slow)).toBe(true)
		} finally {
			clock.mockRestore()
		}
	})
})

describe("incremental translation", () => {
	it("commits events in chunks, so a pass that runs out of time resumes where it stopped", async () => {
		await seedLinked()
		const account = accountKey(content.account)
		const entities = Array.from({ length: 250 }, (_, index) => `entity-${index}`)
		const facts = entities.map((entityId) => ({
			entityId,
			source: "kimchi",
			sourceVersion: "test",
			deviceId: requestId,
			observeTime: "2026-10-04T12:00:00Z",
			coverage: { code: "fixture", count: "1" },
		}))
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({
			accounts: [{ account: content.account, facts, recordHashes: [] }],
			units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
			unresolved: [],
		})
		// Frozen from the start, so the pass deadline is exactly start + 5 s. A
		// running clock raced the pass's own start on a slow runner.
		const start = Date.now()
		const clock = vi.spyOn(Date, "now").mockReturnValue(start)
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

	it("a pass over an unresolvable group skips its full rebuild while inputs stand still", async () => {
		await seedLinked()
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({
			accounts: [],
			units: [],
			unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(1)
		// Identical markers: no retranslation until the retry window passes — the stall the user feels.
		await run()
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(1)
		// New evidence flips the signature: the input stands still rule does not hide it.
		const path = join(directory, "work-attribution", "source.jsonl")
		await appendFile(
			path,
			`${JSON.stringify({ version: 1, workId: "55555555-5555-4555-8555-555555555555", sessionId: "private-session", type: "work", recordedAt: new Date().toISOString() })}\n`,
		)
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(2)
	})

	it("a persistently unsettled group retries only after the stalled window passes", async () => {
		await seedLinked()
		// An identity lookup that keeps failing leaves the group's markers in place, so the pass runs again —
		// but the full rebuild waits out the window while the identical inputs produce the identical outcome.
		vi.spyOn(providerApi, "lookupRepositoryIdentity").mockRejectedValue(new LookupError("offline", "retry"))
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({
			accounts: [],
			units: [],
			unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(1)
		expect(backendFor(directory).markedRecords().length).toBeGreaterThan(0)
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(1)
		const clock = vi.spyOn(Date, "now")
		try {
			clock.mockReturnValue(Date.now() + 5 * 60_000 + 1_000)
			await run()
			expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(2)
			// The window restarts from the retry, so the next pass waits again — it does not revert to re-running
			// the identical group on every tick.
			await run()
			expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(2)
			clock.mockReturnValue(Date.now() + 10 * 60_000 + 2_000)
			await run()
		} finally {
			clock.mockRestore()
		}
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(3)
	})

	it("backs off a group whose translation prelude exceeds its time limit", async () => {
		await seedLinked()
		const backend = backendFor(directory)
		const build = vi.mocked(eventBuilder.buildEvents)
		const clock = vi.spyOn(Date, "now")
		const start = Date.now()
		build.mockRejectedValueOnce(new TranslationPreludeTimeoutError("PR reporting translation time limit exceeded"))
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		try {
			await run()
			expect(Object.keys(JSON.parse(backend.getNote("agent", "translation-stalled") ?? "{}"))).toHaveLength(1)
			expect(backend.getNote("agent", "translation-plan")).toBeUndefined()
			expect(backend.getNote("agent", "translation-progress")).toBeUndefined()
			expect(backend.markedRecords()).not.toEqual([])

			// The identical group does not pay for another prelude until its retry window expires.
			await run()
			expect(build).toHaveBeenCalledTimes(1)
			expect((await readReportingState(directory)).error).toBe(
				"Some PR cost events are waiting for complete original evidence or a repository identity",
			)

			clock.mockReturnValue(start + 5 * 60_000 + 1_000)
			await run()
			expect(build).toHaveBeenCalledTimes(2)
		} finally {
			clock.mockRestore()
		}
	})

	it("does not stall a group when its parent capture is cancelled", async () => {
		await seedLinked()
		const backend = backendFor(directory)
		const controller = new AbortController()
		vi.mocked(eventBuilder.buildEvents).mockImplementationOnce(() => {
			const reason = new TranslationPreludeTimeoutError("PR reporting translation time limit exceeded")
			controller.abort(reason)
			return Promise.reject(reason)
		})
		await reconcileReporting(directory, "/project", controller.signal, () => {})
		expect(backend.getNote("agent", "translation-stalled")).toBeUndefined()
		expect(backend.getNote("agent", "translation-plan")).toBeUndefined()
		expect(backend.markedRecords()).not.toEqual([])
		expect((await readReportingState(directory)).error).toBeUndefined()
	})

	it("does not stall on an unrelated error with the prelude timeout message", async () => {
		await seedLinked()
		vi.mocked(eventBuilder.buildEvents).mockRejectedValueOnce(new Error("PR reporting translation time limit exceeded"))
		await reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		expect(backendFor(directory).getNote("agent", "translation-stalled")).toBeUndefined()
	})

	it("does not stall on a reconciliation lease failure", async () => {
		await seedLinked()
		await expect(
			reconcileReporting(directory, "/project", new AbortController().signal, () => {
				throw new Error("lease lost")
			}),
		).rejects.toThrow("lease lost")
		expect(backendFor(directory).getNote("agent", "translation-stalled")).toBeUndefined()
	})

	it("a corrupt stalled note discards the windows rather than freezing every pass", async () => {
		await seedLinked()
		vi.spyOn(providerApi, "lookupRepositoryIdentity").mockRejectedValue(new LookupError("offline", "retry"))
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({
			accounts: [],
			units: [],
			unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(1)
		backendFor(directory).putNote("agent", "translation-stalled", "{corrupt")
		// The note reads as absent: the group retries at the next window and the windows start fresh.
		const clock = vi.spyOn(Date, "now")
		try {
			clock.mockReturnValue(Date.now() + 5 * 60_000 + 1_000)
			await run()
			expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(2)
			// The group still reports its own waiting state; a corrupt note never becomes a capture failure.
			expect((await readReportingState(directory)).error).toBe(
				"Some PR cost events are waiting for complete original evidence or a repository identity",
			)
			clock.mockReturnValue(Date.now() + 30_000)
			await run()
		} finally {
			clock.mockRestore()
		}
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(2)
	})

	it("a stalled window stamped far into the future is pruned, not a lock-out", async () => {
		await seedLinked()
		vi.spyOn(providerApi, "lookupRepositoryIdentity").mockRejectedValue(new LookupError("offline", "retry"))
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({
			accounts: [],
			units: [],
			unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(1)
		const backend = backendFor(directory)
		const body = backend.getNote("agent", "translation-stalled")
		if (!body) throw new Error("the first unresolved attempt stamps a window")
		const windows: Record<string, { at: number }> = JSON.parse(body)
		for (const key of Object.keys(windows)) windows[key] = { at: Date.now() + 365 * 24 * 3_600_000 }
		backend.putNote("agent", "translation-stalled", JSON.stringify(windows))
		const clock = vi.spyOn(Date, "now")
		try {
			// Still impossibly far ahead after the window: the entry is invalid on its face, not waiting.
			clock.mockReturnValue(Date.now() + 5 * 60_000 + 1_000)
			await run()
		} finally {
			clock.mockRestore()
		}
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(2)
	})

	it("a group whose repository identity stays unknown waits out the retry window instead of rebuilding each pass", async () => {
		await seedLinked()
		vi.spyOn(providerApi, "lookupRepositoryIdentity").mockRejectedValue(new LookupError("offline", "retry"))
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({ accounts: [], units: [], unresolved: [] })
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(1)
		const clock = vi.spyOn(Date, "now")
		const start = Date.now()
		try {
			// The next 30 s tick, past the lookup cooldown: the unchanged group does not re-pay its prelude.
			clock.mockReturnValue(start + 31_000)
			await run()
			expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(1)
			// The group reports that it waits, not a capture failure.
			expect((await readReportingState(directory)).error).toBe(
				"Some PR cost events are waiting for complete original evidence or a repository identity",
			)
			clock.mockReturnValue(start + 5 * 60_000 + 1_000)
			await run()
			expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(2)
		} finally {
			clock.mockRestore()
		}
		// Unsettled identities keep the markers for a later round.
		expect(backendFor(directory).markedRecords()).not.toEqual([])
	})

	it("a later attempt that resolves the group lifts its stalled window", async () => {
		await seedLinked()
		const lookup = vi
			.spyOn(providerApi, "lookupRepositoryIdentity")
			.mockRejectedValue(new LookupError("offline", "retry"))
		vi.mocked(eventBuilder.buildEvents).mockResolvedValueOnce({
			accounts: [],
			units: [],
			unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
		})
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({ accounts: [], units: [], unresolved: [] })
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		const backend = backendFor(directory)
		const stamped = backend.getNote("agent", "translation-stalled")
		expect(Object.keys(JSON.parse(stamped ?? "{}"))).toHaveLength(1)
		lookup.mockResolvedValue({ provider: "github", host: "github.com", name: "example/repo", id: "42" })
		const clock = vi.spyOn(Date, "now")
		try {
			clock.mockReturnValue(Date.now() + 5 * 60_000 + 1_000)
			await run()
		} finally {
			clock.mockRestore()
		}
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(2)
		// Resolved groups leave no window behind: the next pass is free to run them again.
		expect(Object.keys(JSON.parse(backend.getNote("agent", "translation-stalled") ?? "{}"))).toHaveLength(0)
	})

	it.each([
		"damaged elements",
		"missing facts",
	] as const)("a plan for a suspended pass with %s falls back to a full rebuild", async (kind) => {
		await seedLinked()
		const account = accountKey(content.account)
		const entities = Array.from({ length: 250 }, (_, index) => `entity-${index}`)
		const facts = entities.map((entityId) => ({
			entityId,
			source: "kimchi",
			sourceVersion: "test",
			deviceId: requestId,
			observeTime: "2026-10-04T12:00:00Z",
			coverage: { code: "fixture", count: "1" },
		}))
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({
			accounts: [{ account: content.account, facts, recordHashes: [] }],
			units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
			unresolved: [],
		})
		// Frozen from the start, so the pass deadline is exactly start + 5 s. A
		// running clock raced the pass's own start on a slow runner.
		const start = Date.now()
		const clock = vi.spyOn(Date, "now").mockReturnValue(start)
		// The first chunk leaves the pass without time for another: the notes suspend the group mid-way.
		vi.mocked(outbox.observeEvents).mockImplementationOnce(() => {
			clock.mockReturnValue(start + 4_800)
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		clock.mockRestore()
		const backend = backendFor(directory)
		const observed = () =>
			vi.mocked(outbox.observeEvents).mock.calls.flatMap(([, , list]) => list.map((fact) => fact.entityId))
		expect(observed()).toEqual(entities.slice(0, 100))
		// Storage damage that still parses: units of null, or facts emptied so replaying the plan would
		// commit nothing and still clear the markers.
		const plan = JSON.parse(backend.getNote("agent", "translation-plan") ?? "{}") as {
			units?: unknown
			accounts: { facts: unknown[] }[]
		}
		if (kind === "damaged elements") plan.units = [null]
		else for (const group of plan.accounts) group.facts = []
		backend.putNote("agent", "translation-plan", JSON.stringify(plan))
		// The corrupt plan rebuilds instead of substituting: the prelude re-runs and every entity commits.
		vi.mocked(eventBuilder.buildEvents).mockClear()
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(1)
		expect(observed()).toEqual(expect.arrayContaining(entities))
		expect(backend.markedRecords()).toEqual([])
	})

	it("a progress count beyond its plan's units rebuilds the plan instead of retiring the group", async () => {
		await seedLinked()
		const account = accountKey(content.account)
		const entities = Array.from({ length: 150 }, (_, index) => `entity-${index}`)
		const facts = entities.map((entityId) => ({
			entityId,
			source: "kimchi",
			sourceVersion: "test",
			deviceId: requestId,
			observeTime: "2026-10-04T12:00:00Z",
			coverage: { code: "fixture", count: "1" },
		}))
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({
			accounts: [{ account: content.account, facts, recordHashes: [] }],
			units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
			unresolved: [],
		})
		// Frozen from the start, so the pass deadline is exactly start + 5 s. A
		// running clock raced the pass's own start on a slow runner.
		const start = Date.now()
		const clock = vi.spyOn(Date, "now").mockReturnValue(start)
		vi.mocked(outbox.observeEvents).mockImplementationOnce(() => {
			clock.mockReturnValue(start + 4_800)
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		clock.mockRestore()
		const backend = backendFor(directory)
		const progress = JSON.parse(backend.getNote("agent", "translation-progress") ?? "{}") as Record<string, unknown>
		// A count beyond the plan's units would skip the loop and clear the markers without committing a fact.
		progress.units = 999_999
		backend.putNote("agent", "translation-progress", JSON.stringify(progress))
		await run()
		const observed = vi
			.mocked(outbox.observeEvents)
			.mock.calls.flatMap(([, , list]) => list.map((fact) => fact.entityId))
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(2)
		expect(observed).toEqual(expect.arrayContaining(entities))
		expect(backend.markedRecords()).toEqual([])
	})

	it("a pass that runs out of time during a big group resumes after the prelude, without rebuilding it", async () => {
		await seedLinked()
		const account = accountKey(content.account)
		const entities = Array.from({ length: 250 }, (_, index) => `entity-${index}`)
		const facts = entities.map((entityId) => ({
			entityId,
			source: "kimchi",
			sourceVersion: "test",
			deviceId: requestId,
			observeTime: "2026-10-04T12:00:00Z",
			coverage: { code: "fixture", count: "1" },
		}))
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({
			accounts: [{ account: content.account, facts, recordHashes: [] }],
			units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
			unresolved: [],
		})
		// Frozen from the start, so the pass deadline is exactly start + 5 s. A
		// running clock raced the pass's own start on a slow runner.
		const start = Date.now()
		const clock = vi.spyOn(Date, "now").mockReturnValue(start)
		vi.mocked(outbox.observeEvents).mockImplementationOnce(() => {
			clock.mockReturnValue(start + 4_800)
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		clock.mockRestore()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(1)
		await run()
		// The plan carried over: the resume does NOT re-run the prelude — one build across both passes.
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(1)
		const observed = () =>
			vi.mocked(outbox.observeEvents).mock.calls.flatMap(([, , list]) => list.map((fact) => fact.entityId))
		expect(observed()).toEqual(entities)
		expect(backendFor(directory).markedRecords()).toEqual([])
	})

	it("a suspended group resumes its plan when records arrive between passes, and leaves only them marked", async () => {
		await seedLinked()
		const account = accountKey(content.account)
		const entities = Array.from({ length: 250 }, (_, index) => `entity-${index}`)
		const facts = entities.map((entityId) => ({
			entityId,
			source: "kimchi",
			sourceVersion: "test",
			deviceId: requestId,
			observeTime: "2026-10-04T12:00:00Z",
			coverage: { code: "fixture", count: "1" },
		}))
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({
			accounts: [{ account: content.account, facts, recordHashes: [] }],
			units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
			unresolved: [],
		})
		// Frozen from the start, so the pass deadline is exactly start + 5 s. A
		// running clock raced the pass's own start on a slow runner.
		const start = Date.now()
		const clock = vi.spyOn(Date, "now").mockReturnValue(start)
		vi.mocked(outbox.observeEvents).mockImplementationOnce(() => {
			clock.mockReturnValue(start + 4_800)
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		clock.mockRestore()
		const backend = backendFor(directory)
		const before = new Set(backend.markedRecords().map((row) => row.recordHash))
		// A live session appends to the same work while the group is suspended: a new marker joins the group.
		await appendFile(
			join(directory, "work-attribution", "source.jsonl"),
			`${JSON.stringify({
				version: 1,
				type: "request",
				workId: "55555555-5555-4555-8555-555555555555",
				sessionId: "private-session",
				recordedAt: "2026-10-04T12:05:00.000Z",
				requestId: "66666666-6666-4666-8666-666666666666",
				startedAt: "2026-10-04T12:05:00.000Z",
				scope: { account: content.account, repository: "/private/repo/.git" },
			})}\n`,
		)
		await run()
		// The plan carried over despite the new record: one build, every planned entity committed.
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(1)
		const observed = () =>
			vi.mocked(outbox.observeEvents).mock.calls.flatMap(([, , list]) => list.map((fact) => fact.entityId))
		expect(observed()).toEqual(entities)
		// Only the planned markers cleared; the record captured after the plan waits for its own round.
		const left = backend.markedRecords()
		expect(left).toHaveLength(1)
		expect(before.has(left[0].recordHash)).toBe(false)
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(2)
		expect(backend.markedRecords()).toEqual([])
	})

	it("an unsettled resumed plan leaves new markers ready for the next round", async () => {
		await seedLinked()
		vi.spyOn(providerApi, "lookupRepositoryIdentity").mockRejectedValue(new LookupError("offline", "retry"))
		const account = accountKey(content.account)
		const entities = Array.from({ length: 250 }, (_, index) => `entity-${index}`)
		const facts = entities.map((entityId) => ({
			entityId,
			source: "kimchi",
			sourceVersion: "test",
			deviceId: requestId,
			observeTime: "2026-10-04T12:00:00Z",
			coverage: { code: "fixture", count: "1" },
		}))
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({
			accounts: [{ account: content.account, facts, recordHashes: [] }],
			units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
			unresolved: [],
		})
		// Frozen from the start, so the pass deadline is exactly start + 5 s. A
		// running clock raced the pass's own start on a slow runner.
		const start = Date.now()
		const clock = vi.spyOn(Date, "now").mockReturnValue(start)
		vi.mocked(outbox.observeEvents).mockImplementationOnce(() => {
			clock.mockReturnValue(start + 4_800)
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		clock.mockRestore()
		const backend = backendFor(directory)
		expect(backend.getNote("agent", "translation-plan")).toBeDefined()

		await appendFile(
			join(directory, "work-attribution", "source.jsonl"),
			`${JSON.stringify({
				version: 1,
				type: "request",
				workId: "55555555-5555-4555-8555-555555555555",
				sessionId: "private-session",
				recordedAt: "2026-10-04T12:05:00.000Z",
				requestId: "66666666-6666-4666-8666-666666666666",
				startedAt: "2026-10-04T12:05:00.000Z",
				scope: { account: content.account, repository: "/private/repo/.git" },
			})}\n`,
		)
		await run()
		// The old plan resumes without another prelude, but its added marker does not rest with the old result.
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(1)
		expect(Object.keys(JSON.parse(backend.getNote("agent", "translation-stalled") ?? "{}"))).toHaveLength(0)
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(2)
		expect(Object.keys(JSON.parse(backend.getNote("agent", "translation-stalled") ?? "{}"))).toHaveLength(1)
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(2)
		expect(backend.markedRecords()).not.toEqual([])
	})

	it("a suspended plan is rebuilt when a marker it covers is no longer pending", async () => {
		await seedLinked()
		const account = accountKey(content.account)
		const entities = Array.from({ length: 250 }, (_, index) => `entity-${index}`)
		vi.mocked(eventBuilder.buildEvents).mockResolvedValue({
			accounts: [
				{
					account: content.account,
					facts: entities.map((entityId) => ({
						entityId,
						source: "kimchi",
						sourceVersion: "test",
						deviceId: requestId,
						observeTime: "2026-10-04T12:00:00Z",
						coverage: { code: "fixture", count: "1" },
					})),
					recordHashes: [],
				},
			],
			units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
			unresolved: [],
		})
		// Frozen from the start, so the pass deadline is exactly start + 5 s. A
		// running clock raced the pass's own start on a slow runner.
		const start = Date.now()
		const clock = vi.spyOn(Date, "now").mockReturnValue(start)
		vi.mocked(outbox.observeEvents).mockImplementationOnce(() => {
			clock.mockReturnValue(start + 4_800)
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		clock.mockRestore()
		const backend = backendFor(directory)
		// Another process finished one of the plan's records in between: the plan no longer describes pending work.
		const [first] = backend.markedRecords()
		backend.tx(() => backend.clearTranslation(first.recordHash))
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(2)
		expect(backend.markedRecords()).toEqual([])
	})

	it("a plan whose construction outlasts the pass is saved and resumed, not rebuilt every pass", async () => {
		await seedLinked()
		const account = accountKey(content.account)
		const entities = Array.from({ length: 150 }, (_, index) => `entity-${index}`)
		const built = {
			accounts: [
				{
					account: content.account,
					facts: entities.map((entityId) => ({
						entityId,
						source: "kimchi",
						sourceVersion: "test",
						deviceId: requestId,
						observeTime: "2026-10-04T12:00:00Z",
						coverage: { code: "fixture", count: "1" },
					})),
					recordHashes: [],
				},
			],
			units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
			unresolved: [],
		}
		// Frozen from the start, so the pass deadline is exactly start + 5 s. A
		// running clock raced the pass's own start on a slow runner.
		const start = Date.now()
		const clock = vi.spyOn(Date, "now").mockReturnValue(start)
		// A large group's read, report and event build take longer than one 5 s pass.
		vi.mocked(eventBuilder.buildEvents).mockImplementation(async () => {
			clock.mockReturnValue(start + 6_000)
			return built
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		clock.mockRestore()
		const backend = backendFor(directory)
		// The finished prelude is kept even though the pass had no time left to commit a chunk.
		expect(backend.getNote("agent", "translation-plan")).toBeDefined()
		expect((await readReportingState(directory)).error).toBeUndefined()
		await run()
		expect(eventBuilder.buildEvents).toHaveBeenCalledTimes(1)
		const observed = vi
			.mocked(outbox.observeEvents)
			.mock.calls.flatMap(([, , list]) => list.map((fact) => fact.entityId))
		expect(observed).toEqual(entities)
		expect(backend.markedRecords()).toEqual([])
	})

	it("the suspended group resumes before another changed group can take over the plan slot", async () => {
		await seedLinked()
		const big = "55555555-5555-4555-8555-555555555555"
		const small = "11111111-1111-4111-8111-111111111111"
		const smallRequest = (index: number) => ({
			version: 1,
			type: "request",
			workId: small,
			sessionId: "other-session",
			recordedAt: `2026-10-04T12:0${index}:00.000Z`,
			requestId: `7777777${index}-7777-4777-8777-777777777777`,
			startedAt: `2026-10-04T12:0${index}:00.000Z`,
			scope: { account: content.account, repository: "/private/repo/.git" },
		})
		const journal = join(directory, "work-attribution", "source.jsonl")
		await appendFile(journal, `${JSON.stringify(smallRequest(1))}\n`)
		const account = accountKey(content.account)
		const fixture = (prefix: string, count: number) => {
			const ids = Array.from({ length: count }, (_, index) => `${prefix}-${index}`)
			return {
				ids,
				built: {
					accounts: [
						{
							account: content.account,
							facts: ids.map((entityId) => ({
								entityId,
								source: "kimchi",
								sourceVersion: "test",
								deviceId: requestId,
								observeTime: "2026-10-04T12:00:00Z",
								coverage: { code: "fixture", count: "1" },
							})),
							recordHashes: [],
						},
					],
					units: ids.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
					unresolved: [],
				},
			}
		}
		const bigGroup = fixture("big", 250)
		const smallGroup = fixture("small", 1)
		const ofBig = (stored: readonly { workId: string }[]) => stored.some((row) => row.workId === big)
		vi.mocked(eventBuilder.buildEvents).mockImplementation(async (stored) =>
			ofBig(stored) ? bigGroup.built : smallGroup.built,
		)
		// Frozen from the start, so the pass deadline is exactly start + 5 s. A
		// running clock raced the pass's own start on a slow runner.
		const start = Date.now()
		const clock = vi.spyOn(Date, "now").mockReturnValue(start)
		// The small group (first by work id) completes; the big group's first chunk then exhausts the pass.
		vi.mocked(outbox.observeEvents).mockImplementation((_dir, _account, list) => {
			if (list[0]?.entityId === "big-0") clock.mockReturnValue(start + 4_800)
		})
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		clock.mockRestore()
		const bigBuilds = () => vi.mocked(eventBuilder.buildEvents).mock.calls.filter(([stored]) => ofBig(stored)).length
		expect(bigBuilds()).toBe(1)
		// The small group changes again while the big one is suspended.
		await appendFile(journal, `${JSON.stringify(smallRequest(2))}\n`)
		await run()
		// The big group resumed its plan instead of losing the slot to the small group's rebuild.
		expect(bigBuilds()).toBe(1)
		const observed = vi
			.mocked(outbox.observeEvents)
			.mock.calls.flatMap(([, , list]) => list.map((fact) => fact.entityId))
		expect(observed).toEqual(expect.arrayContaining(bigGroup.ids))
		expect(backendFor(directory).markedRecords()).toEqual([])
	})

	it("drives event translation with the stretcher the prelude uses", async () => {
		await seedLinked()
		respond(accepted)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		const call = vi.mocked(eventBuilder.buildEvents).mock.calls.at(-1)
		expect(call?.[7]).toBeTypeOf("function")
		// Identity, not just presence: the captured fn must carry the prelude budget — after 2_000
		// rows it must park the loop for real (a no-op stretch would never let this tick fire).
		const stretch = call?.[7] as () => Promise<void>
		let ticked = false
		setImmediate(() => {
			ticked = true
		})
		for (let index = 0; index < 2_001; index++) await stretch()
		expect(ticked).toBe(true)
	})

	it("rebuilds only the group of works whose records changed", async () => {
		await seedLinked()
		const path = join(directory, "work-attribution", "source.jsonl")
		const other = { version: 1, workId: "66666666-6666-4666-8666-666666666666", sessionId: "other-session" }
		await appendFile(
			path,
			`${JSON.stringify({ ...other, type: "request", requestId: "77777777-7777-4777-8777-777777777777", startedAt: "2026-10-04T12:00:00.000Z", recordedAt: "2026-10-04T12:00:00.000Z", scope: { account: content.account, repository: "/other/.git" } })}\n`,
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
})

describe("idle reporting passes", () => {
	it("performs no journal body reads on an unchanged idle pass", async () => {
		await seedLinked()
		const settled = new Date(Date.now() - 60_000)
		fs.utimesSync(join(directory, "work-attribution", "source.jsonl"), settled, settled)
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
		const calculate = vi.spyOn(costs, "calculatePullRequestCostsAsync")
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
		const calculate = vi.spyOn(costs, "calculatePullRequestCostsAsync")
		await appendFile(path, '{"type":"request"\n')
		await run()
		expect(calculate).not.toHaveBeenCalled()
		expect((await readReportingState(directory)).error).toContain("complete inventory")
		await appendFile(path, `${JSON.stringify({ ...JSON.parse(valid), recordedAt: new Date().toISOString() })}\n`)
		await run()
		expect(calculate).toHaveBeenCalledOnce()
		expect((await readReportingState(directory)).error).toBeUndefined()
		const problems: summary.WorkRecordProblem[] = []
		reportJournalProblems(directory, (problem) => problems.push(problem))
		expect(problems).toEqual([])
		expect(posts()).toHaveLength(1)
	})

	it("skips unchanged passes, reads journals in the background and translates only new records", async () => {
		await seedLinked()
		respond(accepted)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		await run()
		await run()
		const calculate = vi.spyOn(costs, "calculatePullRequestCostsAsync")
		const blockingRead = vi.spyOn(summary, "readWorkRecords")
		await run()
		expect(calculate).not.toHaveBeenCalled()
		// Translated records stay translated: an hour later, without new records, nothing is rebuilt.
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000)
		await run()
		expect(calculate).not.toHaveBeenCalled()
		await appendFile(
			join(directory, "work-attribution", "source.jsonl"),
			`${JSON.stringify({ version: 1, type: "work", workId: "55555555-5555-4555-8555-555555555555", sessionId: "private-session", recordedAt: new Date().toISOString() })}\n`,
		)
		await run()
		expect(calculate).toHaveBeenCalledOnce()
		expect(blockingRead).not.toHaveBeenCalled()
		expect(posts()).toHaveLength(1)
	})
})

describe("gated quiet passes", () => {
	beforeEach(resetReportingPassGates)

	it("stays quiet between due times, honors opt-outs, and fires the deferred retry at its stamped time", async () => {
		await seedLinked()
		let refuse = true
		http.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: refuse
					? new Response(null, { status: 500 })
					: Response.json({ status: "accepted", revision: "1", receivedAt: new Date().toISOString() }),
		)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		const freeze = vi.spyOn(queue, "freezeSnapshots")
		await run()
		expect(posts()).toHaveLength(1)
		const [frozen] = await pendingFrozenSnapshots(directory, () => {}, Date.now() - 1)
		if (!frozen) throw new Error("a deferred snapshot must wait between pass gates")
		// The pass's own deferral bookkeeping is absorbed into the stamp: nothing the pass did not
		// write itself changed on disk, so the very next tick runs no full cycle at all.
		const settled = freeze.mock.calls.length
		await run()
		expect(freeze.mock.calls.length).toBe(settled)
		expect(posts()).toHaveLength(1)
		// Opting out is a write from outside the pass: it re-opens one pass and then stays quiet.
		await setReportingEnabled(directory, false)
		vi.spyOn(Date, "now").mockReturnValue(frozen.entry.retryAt + 1000)
		await run()
		expect(freeze.mock.calls.length).toBeGreaterThan(settled)
		const disabled = freeze.mock.calls.length
		await run()
		expect(freeze.mock.calls.length).toBe(disabled)
		expect(posts()).toHaveLength(1)
		// Re-enabled and past the stamped retry time, the due snapshot goes out.
		await setReportingEnabled(directory, true)
		refuse = false
		await run()
		expect(freeze.mock.calls.length).toBeGreaterThan(disabled)
		expect(posts()).toHaveLength(2)
	})

	it("re-opens for a foreign queue write, not for a content-identical rewrite", async () => {
		await seedLinked()
		let refuse = true
		http.mockImplementation(async (input) =>
			String(input).endsWith("api-keys:verify")
				? Response.json({ organizationId: org, userId: user })
				: refuse
					? new Response(null, { status: 500 })
					: Response.json({ status: "accepted", revision: "1", receivedAt: new Date().toISOString() }),
		)
		const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
		const freeze = vi.spyOn(queue, "freezeSnapshots")
		await run()
		const settled = freeze.mock.calls.length
		await run()
		expect(freeze.mock.calls.length).toBe(settled)
		expect(posts()).toHaveLength(1)
		// A content-identical rewrite (an editor touch, a sync tool) moves no real state: the tick
		// stays quiet — only real writes move the version the gate reads.
		const path = join(directory, "pr-cost-reporting", "state.json")
		await writeFile(path, await readFile(path))
		await run()
		expect(freeze.mock.calls.length).toBe(settled)
		// A foreign write — any session's real queue change — bumps the version the stamp keeps:
		// the next pass runs fully and sees the retry as due at its stamped time.
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000)
		refuse = false
		await recordReportingError(directory, "foreign writer")
		await run()
		expect(freeze.mock.calls.length).toBeGreaterThan(settled)
		expect(posts()).toHaveLength(2)
	})
})

it("releases a hold whose evidence stayed incomplete past the expiry horizon", async () => {
	// Directly age the queue file: the hold is a week+ old and no completing evidence ever arrived.
	const file = join(directory, "pr-cost-reporting", "state.json")
	const state = JSON.parse(await readFile(file, "utf8"))
	const [seeded] = Object.values(state.entries) as {
		held?: boolean
		heldAt?: number
	}[]
	seeded.held = true
	seeded.heldAt = Date.now() - HOLD_EXPIRY_MS - 60_000
	await writeFile(file, `${JSON.stringify(state)}\n`)
	// The same capture passes again: an expired hold releases instead of re-parking the entry.
	await queueSnapshots(directory, [content])
	let entry = Object.values((await readReportingState(directory)).entries)[0]
	expect(entry.held).toBeUndefined()
	expect(entry.heldAt).toBeUndefined()
	await deliver()
	entry = Object.values((await readReportingState(directory)).entries)[0]
	expect(readPendingBody(directory, entry)).toBeUndefined()
	expect(entry.lastAcknowledgedAt).toBeDefined()
})

it("keeps a fresh hold parked while its evidence looks incomplete", async () => {
	// Same evidence, but the capture admits its inventory is incomplete: the entry is held.
	await queueSnapshots(directory, [{ account: content.account, content: content.content, incomplete: true }])
	const entry = Object.values((await readReportingState(directory)).entries)[0]
	expect(entry.held).toBe(true)
	expect(entry.heldAt).toBeDefined()
	http.mockClear()
	await deliver()
	expect(http).not.toHaveBeenCalled()
})

it("sleeps between a failing snapshot's own retry deadlines instead of chasing its bookkeeping", async () => {
	vi.spyOn(Math, "random").mockReturnValue(0.5)
	http.mockImplementation(async (input) =>
		String(input).endsWith("api-keys:verify")
			? Response.json({ organizationId: org, userId: user })
			: new Response(null, { status: 500 }),
	)
	const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
	const freeze = vi.spyOn(queue, "freezeSnapshots")
	await run()
	expect(posts()).toHaveLength(1)
	let entry = Object.values((await readReportingState(directory)).entries)[0]
	const firstRetryAt = entry.retryAt
	// The pass's own deferral bookkeeping (attempts/retryAt in state.json, ledger commits) moved
	// the version signals the gate reads; its stamp absorbs them: the very next tick is quiet.
	const settled = freeze.mock.calls.length
	await run()
	expect(freeze.mock.calls.length).toBe(settled)
	await run()
	expect(freeze.mock.calls.length).toBe(settled)
	expect(posts()).toHaveLength(1)
	// A retry's clock is the later of backoff and the upload window after the last attempt;
	// middling ticks stay quiet both ways.
	vi.spyOn(Date, "now").mockReturnValue(firstRetryAt + 1)
	await run()
	expect(freeze.mock.calls.length).toBe(settled)
	const wake = Math.max(firstRetryAt, (entry.uploadedAt ?? 0) + UPLOAD_INTERVAL_MS) + 1
	// At the entry's own schedule exactly one pass runs and retries; its failure re-parks later.
	vi.spyOn(Date, "now").mockReturnValue(wake)
	await run()
	expect(freeze.mock.calls.length).toBeGreaterThan(settled)
	expect(posts()).toHaveLength(2)
	entry = Object.values((await readReportingState(directory)).entries)[0]
	expect(entry.retryAt).toBeGreaterThan(firstRetryAt)
	const reSettled = freeze.mock.calls.length
	await run()
	expect(freeze.mock.calls.length).toBe(reSettled)
})

it("a 413-trimmed body is due again on the next pass instead of riding the attempt's own window", async () => {
	// The trim REPLACES the frozen row: attempts/retryAt reset to zero and the upload-window
	// clock clears, so the halved body retries immediately — the stamp must not keep the
	// attempt's own rejected-window picture, or the gate would sit on a body the queue says
	// is due for minutes (and, for a capped-limit trim, for a limit-length backoff).
	const requests = [
		content.content.requests[0],
		...Array.from({ length: 39 }, (_, index) => ({
			requestId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
			billingRecordIds: [],
			startedAt: "2026-10-04T12:00:00Z",
			allocation: { kind: "unlinked" as const, pullRequestIds: [], method: "native" as const },
		})),
	]
	await queueSnapshots(directory, [
		{
			account: content.account,
			content: {
				repository: content.content.repository,
				pullRequests: [],
				requests,
				coverage: { observedRequests: requests.length, unpricedRequests: requests.length, historyComplete: true },
			},
		},
	])
	http.mockImplementation(async (input) =>
		String(input).endsWith("api-keys:verify")
			? Response.json({ organizationId: org, userId: user })
			: new Response(null, { status: 413 }),
	)
	const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
	const freeze = vi.spyOn(queue, "freezeSnapshots")
	await run()
	expect(posts()).toHaveLength(1) // original body rejected
	// Next tick: the trimmed row is due NOW — the gate opens even though the attempt itself
	// just happened (its window would otherwise hold a fresh upload shut for five minutes).
	const afterTrim = freeze.mock.calls.length
	await run()
	expect(posts()).toHaveLength(2) // 40 requests halved to 20, retried immediately
	expect(freeze.mock.calls.length).toBeGreaterThan(afterTrim)
	// Still above the trim floor: second 413 halves 20 -> 16 and is due immediately again.
	const afterSecond = freeze.mock.calls.length
	await run()
	expect(posts()).toHaveLength(3)
	expect(freeze.mock.calls.length).toBeGreaterThan(afterSecond)
	// At the floor the body settles (dead-letter — dead-letter PR on this stack base); the pass
	// after THAT is finally quiet — each immediate reopen up to here traced a due trim, not churn.
	const settled = freeze.mock.calls.length
	await run()
	expect(freeze.mock.calls.length).toBe(settled)
})

it("stamps an event upload parked on backoff at its deadline instead of ticking until it drains", async () => {
	resetReportingPassGates()
	const batch = {
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		accountKey: accountKey(content.account),
		body: new TextEncoder().encode("{}"),
		eventIds: [],
		createdAt: Date.now(),
		orderKey: "",
	}
	backendFor(directory).insertOutboxBatch(batch)
	// The schedule note every failed upload leaves behind: parked for an hour, bound to the
	// queue's current legacy-snapshot resume marker (the note is dropped for any other).
	const resume = backendFor(directory).getNote("agent", "legacy-snapshot-resume")
	backendFor(directory).putNote(
		"pr-cost-delivery",
		accountKey(content.account),
		JSON.stringify({ batchId: batch.id, attempts: 1, retryAt: Date.now() + 60 * 60_000, resume }),
	)
	respond(accepted)
	const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
	const freeze = vi.spyOn(queue, "freezeSnapshots")
	let quiet = freeze.mock.calls.length
	for (let absorbing = 0; absorbing < 8; absorbing++) {
		await run()
		if (freeze.mock.calls.length === quiet) break
		quiet = freeze.mock.calls.length
	}
	const settled = quiet
	// Before the parked upload's deadline: ticks run no cycle at all — the outbox's own
	// backoff note, not a full scan, says when to worry about it again.
	await run()
	expect(freeze.mock.calls.length).toBe(settled)
	await run()
	expect(freeze.mock.calls.length).toBe(settled)
	// Past its deadline the pass re-opens and the upload goes out.
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60_000)
	await run()
	expect(freeze.mock.calls.length).toBeGreaterThan(settled)
})

it("wakes at a hold's expiry deadline, even with no other change to report", async () => {
	// Directly age the queue file: the hold reaches its horizon one minute from now.
	const file = join(directory, "pr-cost-reporting", "state.json")
	const state = JSON.parse(await readFile(file, "utf8"))
	const [seeded] = Object.values(state.entries) as {
		held?: boolean
		heldAt?: number
	}[]
	seeded.held = true
	seeded.heldAt = Date.now() - HOLD_EXPIRY_MS + 60_000
	await writeFile(file, `${JSON.stringify(state)}\n`)
	const run = () => reconcileReporting(directory, "/project", new AbortController().signal, () => {})
	const freeze = vi.spyOn(queue, "freezeSnapshots")
	let quiet = freeze.mock.calls.length
	for (let absorbing = 0; absorbing < 8; absorbing++) {
		await run()
		if (freeze.mock.calls.length === quiet) break
		quiet = freeze.mock.calls.length
	}
	const settled = quiet
	await run()
	expect(freeze.mock.calls.length).toBe(settled)
	// The deadline wakes one pass: it releases the hold and the parked upload finally lands.
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60_000)
	await run()
	expect(freeze.mock.calls.length).toBeGreaterThan(settled)
	const entry = Object.values((await readReportingState(directory)).entries)[0]
	expect(entry.held).toBeUndefined()
	expect(entry.lastAcknowledgedAt).toBeDefined()
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
=======
>>>>>>> ae25b1d (refactor(work-ledger): finish the bridge test migration and HostPorts seams)
})
