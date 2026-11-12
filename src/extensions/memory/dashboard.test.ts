import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { isLoopbackRemote, type MemoryDashboard, startMemoryDashboard } from "./dashboard.js"

// The dashboard serves the memory root directly — an isolated temp root
// carries the crafted queue/trace fixtures.
let memoryRoot: string
let servers: MemoryDashboard[]

beforeEach(() => {
	memoryRoot = mkdtempSync(join(tmpdir(), "kimchi-memory-dashboard-"))
	servers = []
})

afterEach(() => {
	for (const server of servers) server.close()
	rmSync(memoryRoot, { recursive: true, force: true })
})

async function serve(): Promise<MemoryDashboard> {
	const server = await startMemoryDashboard({ memoryRoot, openBrowser: false, port: 0 })
	servers.push(server)
	return server
}

const get = (url: string, path: string) => fetch(url.replace(/\/$/, "") + path, { cache: "no-store" })

const drainEvent = (extra: Record<string, unknown>) => JSON.stringify({ ts: "2026-11-12T10:00:00.000Z", ...extra })

function writeDrain(name: string, lines: string[]): void {
	mkdirSync(join(memoryRoot, "traces"), { recursive: true })
	writeFileSync(join(memoryRoot, "traces", name), lines.join("\n"), "utf-8")
}

function writeJob(name: string, body: unknown): void {
	mkdirSync(join(memoryRoot, "pending"), { recursive: true })
	writeFileSync(join(memoryRoot, "pending", name), JSON.stringify(body), "utf-8")
}

describe("memory dashboard server", () => {
	it("serves the page at /", async () => {
		const { url } = await serve()
		const response = await get(url, "/")
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toContain("text/html")
		expect(await response.text()).toContain("Kimchi Memory Dashboard")
	})

	it("/api/queue lists pending jobs with scope/attempts/staged state, quarantine, and lock state", async () => {
		writeJob("a1.json", {
			messages: [{ role: "user", content: "x" }],
			project: { id: "castai/kimchi" },
			session: "s1",
			drainAttempts: 1,
			staged: { windowHashes: ["h1", "h2"] },
		})
		writeJob("a2.json", {
			messages: [
				{ role: "user", content: "a" },
				{ role: "user", content: "b" },
			],
		})
		mkdirSync(join(memoryRoot, "failed"), { recursive: true })
		writeFileSync(join(memoryRoot, "failed", "dead.json"), "{}", "utf-8")
		const { url } = await serve()
		const response = await get(url, "/api/queue")
		expect(response.status).toBe(200)
		const queue = (await response.json()) as {
			pending: Array<{
				name: string
				messages: number
				project: string | null
				drainAttempts: number
				stagedWindows: number
			}>
			quarantined: string[]
			lock: { state: string }
		}
		expect(queue.lock.state).toBe("free")
		expect(queue.quarantined).toEqual(["dead.json"])
		expect(queue.pending).toHaveLength(2)
		const first = queue.pending.find((p) => p.name === "a1.json")
		expect(first).toMatchObject({ messages: 1, project: "castai/kimchi", drainAttempts: 1, stagedWindows: 2 })
		const second = queue.pending.find((p) => p.name === "a2.json")
		expect(second).toMatchObject({ messages: 2, project: null })
	})

	it("/api/queue marks an unparseable job instead of failing", async () => {
		mkdirSync(join(memoryRoot, "pending"), { recursive: true })
		writeFileSync(join(memoryRoot, "pending", "broken.json"), "{not json", "utf-8")
		const { url } = await serve()
		const queue = (await (await get(url, "/api/queue")).json()) as {
			pending: Array<{ name: string; unparseable: boolean }>
		}
		expect(queue.pending).toEqual([expect.objectContaining({ name: "broken.json", unparseable: true })])
	})

	it("/api/traces returns drains newest-first with summary stats", async () => {
		writeDrain("drain-2026-11-11T09-00-00-111.jsonl", [
			drainEvent({ type: "drain_start", model: "m" }),
			drainEvent({ type: "job", job: "j1.json", windows: 3 }),
			drainEvent({ type: "drain_end", captured: 2, failed: 0, durationMs: 1200, triagedOut: 1, skippedNonDurable: 1 }),
		])
		writeDrain("drain-2026-11-12T09-00-00-222.jsonl", [
			drainEvent({ type: "drain_start", model: "m" }),
			drainEvent({ type: "job", job: "j2.json", windows: 1 }),
			drainEvent({ type: "api", kind: "extraction-user", request: {}, response: {} }),
			drainEvent({ type: "api", kind: "triage", request: {}, error: "HTTP 500", status: 500 }),
		])
		const { url } = await serve()
		const drains = (await (await get(url, "/api/traces")).json()) as Array<{
			name: string
			jobs: number
			windows: number
			added: number
			skipped: number
			apiCalls: number
			errors: number
			finished: boolean
		}>
		expect(drains.map((d) => d.name)).toEqual([
			"drain-2026-11-12T09-00-00-222.jsonl",
			"drain-2026-11-11T09-00-00-111.jsonl",
		])
		expect(drains[0]).toMatchObject({ jobs: 1, windows: 1, apiCalls: 2, errors: 1, finished: false })
		expect(drains[1]).toMatchObject({ jobs: 1, windows: 3, added: 2, skipped: 2, finished: true })
	})

	it("/api/trace serves the full event stream, tolerating a truncated trailing line", async () => {
		writeDrain("drain-2026-11-12T09-00-00-333.jsonl", [
			drainEvent({ type: "drain_start" }),
			drainEvent({ type: "job", job: "j.json" }),
			'{"type":"ph', // truncated tail (crash mid-append / read-while-write)
		])
		const { url } = await serve()
		const response = await get(url, "/api/trace?name=drain-2026-11-12T09-00-00-333.jsonl")
		expect(response.status).toBe(200)
		const body = (await response.json()) as { events: Array<{ type: string }> }
		expect(body.events.map((e) => e.type)).toEqual(["drain_start", "job"])
	})

	it("/api/trace rejects traversal, nested names, non-trace names, and missing files with 400", async () => {
		const { url } = await serve()
		for (const name of ["../secret.jsonl", "sub/drain-x.jsonl", "drain-x.json", "nope.txt", "drain-missing.jsonl"]) {
			const response = await get(url, `/api/trace?name=${encodeURIComponent(name)}`)
			expect(response.status).toBe(400)
		}
	})

	it("unknown paths get 404", async () => {
		const { url } = await serve()
		const response = await get(url, "/nope")
		expect(response.status).toBe(404)
	})

	it("rejects non-loopback peers (the loopback peer check itself)", async () => {
		// The forbidden branch is driven by socket.remoteAddress — not fakeable
		// from a loopback HTTP client, so the predicate is the tested seam.
		expect(isLoopbackRemote("127.0.0.1")).toBe(true)
		expect(isLoopbackRemote("127.10.3.4")).toBe(true)
		expect(isLoopbackRemote("::1")).toBe(true)
		expect(isLoopbackRemote("::ffff:127.0.0.1")).toBe(true)
		expect(isLoopbackRemote("192.168.1.5")).toBe(false)
		expect(isLoopbackRemote("10.0.0.2")).toBe(false)
		expect(isLoopbackRemote("::ffff:192.168.1.5")).toBe(false)
		expect(isLoopbackRemote("")).toBe(false)
		// And a real loopback request itself is served (sanity of the wiring).
		const { url } = await serve()
		expect((await get(url, "/api/queue")).status).toBe(200)
	})
})

describe("memory dashboard — recall (retrieval) endpoints", () => {
	it("/api/recalls returns recalls newest-first with hit/injection/gate/error summaries", async () => {
		writeDrain("recall-2026-11-11T09-00-00-111-0.jsonl", [
			drainEvent({
				type: "recall",
				kind: "digest-init",
				query: "the user's commute",
				hits: [{ text: "commute is 45 minutes", score: 0.9 }],
				injected: ["commute is 45 minutes"],
				durationMs: 42,
			}),
		])
		writeDrain("recall-2026-11-12T09-00-00-222-0.jsonl", [
			drainEvent({
				type: "recall",
				kind: "digest-progressive",
				query: "where next",
				gate: { lookup: "skip" },
				hits: [],
				injected: [],
			}),
		])
		writeDrain("recall-2026-11-12T09-00-00-333-0.jsonl", [
			drainEvent({
				type: "recall",
				kind: "tool-search",
				query: "broken",
				error: "gateway down",
				hits: [],
				injected: [],
				durationMs: 7,
			}),
		])
		const { url } = await serve()
		const recalls = (await (await get(url, "/api/recalls")).json()) as Array<{
			name: string
			kind: string
			hits: number
			injected: number
			gateSkip: boolean
			error: string | null
		}>
		expect(recalls.map((r) => r.name)).toEqual([
			"recall-2026-11-12T09-00-00-333-0.jsonl",
			"recall-2026-11-12T09-00-00-222-0.jsonl",
			"recall-2026-11-11T09-00-00-111-0.jsonl",
		])
		expect(recalls[0]).toMatchObject({ kind: "tool-search", error: "gateway down", hits: 0, injected: 0 })
		expect(recalls[1]).toMatchObject({ kind: "digest-progressive", gateSkip: true })
		expect(recalls[2]).toMatchObject({ kind: "digest-init", hits: 1, injected: 1 })
	})

	it("/api/recall serves the full recall record and rejects non-recall names", async () => {
		writeDrain("recall-2026-11-12T09-00-00-444-0.jsonl", [
			drainEvent({ type: "recall", kind: "digest-init", query: "q", injected: ["f1"] }),
		])
		const { url } = await serve()
		const ok = await get(url, "/api/recall?name=recall-2026-11-12T09-00-00-444-0.jsonl")
		expect(ok.status).toBe(200)
		const body = (await ok.json()) as { events: Array<{ type: string; injected: string[] }> }
		expect(body.events[0]).toMatchObject({ type: "recall", injected: ["f1"] })
		for (const name of ["../x.jsonl", "drain-2026-11-12T09-00-00-444.jsonl", "recall-missing.jsonl"]) {
			expect((await get(url, `/api/recall?name=${encodeURIComponent(name)}`)).status).toBe(400)
		}
	})

	it("/api/recalls surfaces the trigger for loop recalls and tolerates pre-trigger files", async () => {
		writeDrain("recall-2026-11-12T09-10-00-111-0.jsonl", [
			drainEvent({
				type: "recall",
				kind: "digest-progressive",
				trigger: "state-revisit",
				query: "same room again",
				hits: [],
				injected: [],
			}),
		])
		writeDrain("recall-2026-11-11T09-10-00-222-0.jsonl", [
			drainEvent({ type: "recall", kind: "digest-progressive", query: "older", hits: [], injected: [] }),
		])
		const { url } = await serve()
		const recalls = (await (await get(url, "/api/recalls")).json()) as Array<{ name: string; trigger: string | null }>
		expect(recalls[0].trigger).toBe("state-revisit")
		expect(recalls[1].trigger).toBeNull()
	})
})

describe("memory dashboard — pending-job drill-down", () => {
	it("/api/job serves the pending job by exact basename (parsed JSON)", async () => {
		writeJob("job-a1.json", { messages: [{ role: "user", content: "x" }], session: "s1" })
		const { url } = await serve()
		const ok = await get(url, "/api/job?name=job-a1.json")
		expect(ok.status).toBe(200)
		const body = (await ok.json()) as { name: string; job: unknown }
		expect(body.name).toBe("job-a1.json")
		expect(body.job).toMatchObject({ session: "s1" })
	})

	it("/api/job falls back to the raw string for unparseable job files", async () => {
		mkdirSync(join(memoryRoot, "pending"), { recursive: true })
		writeFileSync(join(memoryRoot, "pending", "broken.json"), "{not json", "utf-8")
		const { url } = await serve()
		const body = (await (await get(url, "/api/job?name=broken.json")).json()) as { job: unknown }
		expect(body.job).toBe("{not json")
	})

	it("/api/job rejects traversal, non-json names, non-pending files, and unknown names", async () => {
		writeJob("job-b2.json", { messages: [] })
		mkdirSync(join(memoryRoot, "failed"), { recursive: true })
		writeFileSync(join(memoryRoot, "failed", "dead.json"), "{}", "utf-8")
		const { url } = await serve()
		for (const name of ["../x.json", "job-missing.json", "dead.json", "..win.json", "job b3.json"]) {
			expect((await get(url, `/api/job?name=${encodeURIComponent(name)}`)).status).toBe(400)
		}
	})
})
