import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CaptureBackend, CaptureMessage } from "./capture-worker.js"
import { runCaptureWorker } from "./capture-worker.js"
import { defaultMemoryDir } from "./config.js"
import { DecisionBreaker } from "./decision-gate.js"
import {
	clearDeferredSupersede,
	completeDeferredSupersedePrefix,
	deferredOutageSummary,
	deferredSupersedePath,
	deferSupersede,
	outageDeferralActive,
	readDeferredSupersede,
	readDeferredSupersedeBatch,
} from "./decision-outage.js"

function fakeBackend(): CaptureBackend {
	return {
		add: async () => undefined,
		delete: async () => undefined,
		getAll: async () => ({ results: [] }),
		search: async () => ({ results: [] }),
	}
}

function writeOutageJob(): string {
	const pendingDir = join(defaultMemoryDir(), "pending")
	mkdirSync(pendingDir, { recursive: true })
	const file = join(pendingDir, "deferred.json")
	const message: CaptureMessage = { role: "user", content: "durable observation" }
	writeFileSync(file, JSON.stringify({ session: "capture-id", dedupeSession: "persistent", messages: [message] }))
	return file
}

function closedOutage(): { breaker: DecisionBreaker; now: () => number } {
	let now = 1_000
	const breaker = new DecisionBreaker({ now: () => now, threshold: 1 })
	breaker.recordFailure("outage")
	now += 120_001
	return { breaker, now: () => now }
}

describe("decision outage persistence and deferral", () => {
	const realHome = process.env.HOME
	let home: string
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "kimchi-decision-outage-"))
		process.env.HOME = home
		mkdirSync(defaultMemoryDir(), { recursive: true })
	})
	afterEach(() => {
		process.env.HOME = realHome
		rmSync(home, { recursive: true, force: true })
	})

	it("merges deferred facts atomically and clears them on recovery", () => {
		deferSupersede("personal", ["one"])
		deferSupersede("personal", ["one", "two"])
		expect(readDeferredSupersede("personal").newFacts).toEqual(["one", "two"])
		clearDeferredSupersede("personal")
		expect(readDeferredSupersede("personal").newFacts).toEqual([])
	})

	it("advances deferred cleanup in bounded chunks without replay", () => {
		deferSupersede(
			"personal",
			Array.from({ length: 131 }, (_, index) => `fact-${index}`),
		)
		const first = readDeferredSupersedeBatch("personal")
		expect(first.facts).toHaveLength(64)
		expect(first.cursor).toBe(0)
		completeDeferredSupersedePrefix("personal", first.facts.length)
		const second = readDeferredSupersedeBatch("personal")
		expect(second.facts).toHaveLength(64)
		expect(second.cursor).toBe(64)
		completeDeferredSupersedePrefix("personal", second.facts.length)
		const third = readDeferredSupersedeBatch("personal")
		expect(third.facts).toHaveLength(3)
		expect(third.cursor).toBe(128)
		completeDeferredSupersedePrefix("personal", third.facts.length)
		expect(existsSync(deferredSupersedePath("personal"))).toBe(false)
	})

	it("preserves the cleanup checkpoint when a batch fails", async () => {
		deferSupersede(
			"personal",
			Array.from({ length: 65 }, (_, index) => `fact-${index}`),
		)
		const first = readDeferredSupersedeBatch("personal")
		const { runBatchedSupersede } = await import("./capture-worker.js")
		const backend = fakeBackend()
		backend.search = async () => {
			throw new Error("connection error")
		}
		await runBatchedSupersede(backend, first.facts, async () => [], {
			trace: null,
			store: "personal",
		})
		expect(readDeferredSupersede("personal").completedPrefix).toBe(0)
		expect(readDeferredSupersede("personal").newFacts).toHaveLength(65)
	})

	it("quarantines corrupt deferred state without dropping the evidence", () => {
		mkdirSync(join(defaultMemoryDir(), "deferred-supersede"), { recursive: true })
		writeFileSync(deferredSupersedePath("personal"), "{broken")
		expect(readDeferredSupersede("personal").lastError).toBe("unreadable-state")
		expect(readDeferredSupersede("personal").newFacts).toEqual([])
		const dir = join(defaultMemoryDir(), "deferred-supersede")
		const files = readdirSync(dir)
		expect(files).toHaveLength(1)
		expect(files[0]).toMatch(/^personal\.corrupt-.*\.quarantined$/)
		expect(deferredOutageSummary()?.invalidFiles).toBe(1)
		readDeferredSupersede("personal")
		expect(readdirSync(dir)).toEqual(files)
		expect(deferredOutageSummary()?.invalidFiles).toBe(1)
	})

	it("invalidates a cached summary when an older store file disappears", () => {
		deferSupersede("personal", ["active"])
		deferSupersede("old-project", ["older"])
		const older = deferredSupersedePath("old-project")
		const past = new Date(0)
		utimesSync(older, past, past)
		expect(deferredOutageSummary()).toMatchObject({ deferredSupersedes: 2, deferredStores: 2 })
		clearDeferredSupersede("old-project")
		expect(deferredOutageSummary()).toMatchObject({ deferredSupersedes: 1, deferredStores: 1 })
	})

	it("pauses only after the sustained-outage threshold", () => {
		let now = 1_000
		const breaker = new DecisionBreaker({ now: () => now, threshold: 1 })
		breaker.recordFailure("down")
		expect(breaker.snapshot()).toMatchObject({ open: true, degradedAt: 1_000 })
		expect(outageDeferralActive(breaker, now)).toBe(false)
		now += 120_001
		expect(outageDeferralActive(breaker, now)).toBe(true)
		breaker.recordSuccess()
		expect(outageDeferralActive(breaker, now)).toBe(false)
	})

	it("keeps a real job pending without hash-marking deferral as durable", async () => {
		let now = 1_000
		const performer = new DecisionBreaker({ now: () => now, threshold: 1 })
		performer.recordFailure("outage")
		now += 120_001
		const pendingDir = join(defaultMemoryDir(), "pending")
		mkdirSync(pendingDir, { recursive: true })
		const file = join(pendingDir, "deferred.json")
		const message: CaptureMessage = { role: "user", content: "durable observation" }
		writeFileSync(file, JSON.stringify({ session: "capture-id", dedupeSession: "persistent", messages: [message] }))
		const telemetry = { report: vi.fn(), drain: vi.fn() }
		const captured = await runCaptureWorker(["--job", file, "--db", join(defaultMemoryDir(), "personal/memory.db")], {
			llm: { baseURL: "https://gw.test/v1", apiKey: "k", model: "m" },
			createBackend: async () => fakeBackend(),
			decision: {
				gate: { endpoint: "https://gw.test/typesafe/v1/systemone", apiKey: "k", breaker: performer },
				enabled: new Set(["triage"]),
			},
			telemetry,
		})
		expect(captured).toBe(0)
		expect(telemetry.report).toHaveBeenCalledOnce()
		expect(telemetry.report).toHaveBeenCalledWith(
			expect.objectContaining({ event: "capture.wave", outcome: "deferred" }),
		)
		expect(readFileSync(file, "utf-8")).toContain("durable observation")
	})

	it("recovers deferred supersede once after a successful half-open probe", async () => {
		const { breaker } = closedOutage()
		const file = writeOutageJob()
		deferSupersede("personal", ["existing committed fact"])
		const requests: string[][] = []
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
			const keys = Object.keys(body.questions)
			requests.push(keys)
			return new Response(
				JSON.stringify({
					id: "probe-1",
					model: "d3",
					answers: Object.fromEntries(
						keys.map((key) => [key, { type: "choice", choice: "keep", probabilities: { keep: 1 }, confidence: 1 }]),
					),
					usage: { input_tokens: 1, output_tokens: 0 },
				}),
			)
		}) as unknown as typeof fetch
		const backend = fakeBackend()
		backend.search = async () => ({ results: [{ id: "old", memory: "old fact", score: 0.9 }] })
		await runCaptureWorker(["--job", file, "--db", join(defaultMemoryDir(), "personal/memory.db")], {
			llm: { baseURL: "https://gw.test/v1", apiKey: "k", model: "m" },
			createBackend: async () => backend,
			decision: {
				gate: { endpoint: "https://gw.test/typesafe/v1/systemone", apiKey: "k", breaker, fetchImpl, maxRetries: 0 },
				enabled: new Set(["triage", "supersede"]),
			},
		})
		expect(fetchImpl).toHaveBeenCalledTimes(2)
		expect(requests).toEqual([["available"], ["item_1"]])
		expect(breaker.snapshot().open).toBe(false)
		expect(readDeferredSupersede("personal").newFacts).toEqual([])
		expect(readFileSync(file, "utf-8")).toContain("durable observation")
	})

	it("keeps the job and deferred facts when the recovery probe fails", async () => {
		const { breaker } = closedOutage()
		const file = writeOutageJob()
		deferSupersede("personal", ["existing committed fact"])
		const fetchImpl = vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof fetch
		await expect(
			runCaptureWorker(["--job", file, "--db", join(defaultMemoryDir(), "personal/memory.db")], {
				llm: { baseURL: "https://gw.test/v1", apiKey: "k", model: "m" },
				createBackend: async () => fakeBackend(),
				decision: {
					gate: { endpoint: "https://gw.test/typesafe/v1/systemone", apiKey: "k", breaker, fetchImpl, maxRetries: 0 },
					enabled: new Set(["triage", "supersede"]),
				},
			}),
		).resolves.toBe(0)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		expect(breaker.snapshot().open).toBe(true)
		expect(readDeferredSupersede("personal").newFacts).toEqual(["existing committed fact"])
		expect(readFileSync(file, "utf-8")).toContain("durable observation")
	})
})
