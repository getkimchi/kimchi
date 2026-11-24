import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryCaptureJobStore } from "./capture-jobs.js"
import { CapturedHashLedger, loadCapturedHashes } from "./commit.js"
import { defaultMemoryDir } from "./config.js"
import {
	completeDeferredSupersedePrefix,
	deferredSupersedeBatchSize,
	deferredSupersedePath,
	deferSupersede,
	readDeferredSupersedeBatch,
} from "./decision-outage.js"
import { createTraceRecorder, readTraceEvents } from "./trace.js"

const realHome = process.env.HOME
let home: string

function prepare(): { root: string; store: MemoryCaptureJobStore; trace: ReturnType<typeof createTraceRecorder> } {
	home = mkdtempSync(join(tmpdir(), "kimchi-incremental-ledger-"))
	process.env.HOME = home
	const root = defaultMemoryDir()
	mkdirSync(root, { recursive: true })
	return { root, store: new MemoryCaptureJobStore(), trace: createTraceRecorder() }
}

afterEach(() => {
	vi.restoreAllMocks()
	process.env.HOME = realHome
	delete process.env.KIMCHI_MEMORY_SQLITE_LEDGER
	delete process.env.KIMCHI_MEMORY_DEFERRED_BATCH_SIZE
	rmSync(home, { recursive: true, force: true })
})

async function events(trace: ReturnType<typeof createTraceRecorder>) {
	if (!trace) return []
	await trace.flush?.()
	return readTraceEvents(trace.file)
}

describe("incremental captured hashes pilot", () => {
	it("writes only new hashes per job, then exports one compatible per-wave snapshot", async () => {
		process.env.KIMCHI_MEMORY_SQLITE_LEDGER = "1"
		const { root, store, trace } = prepare()
		store.markHashes(["existing"])
		const ledger = new CapturedHashLedger(new Set(["existing"]), trace, store, root)
		ledger.mark(["one"])
		ledger.save()
		expect(store.hashes()).toEqual(new Set(["existing", "one"]))
		expect(existsSync(join(root, "captured-hashes.json"))).toBe(false)
		ledger.exportSnapshot()
		expect(new Set(JSON.parse(readFileSync(join(root, "captured-hashes.json"), "utf-8")))).toEqual(
			new Set(["existing", "one"]),
		)

		const next = new CapturedHashLedger(loadCapturedHashes(), trace, store, root)
		next.mark(["two"])
		next.save()
		next.exportSnapshot()
		expect(store.hashes()).toEqual(new Set(["existing", "one", "two"]))
		expect(new Set(JSON.parse(readFileSync(join(root, "captured-hashes.json"), "utf-8")))).toEqual(
			new Set(["existing", "one", "two"]),
		)
		expect((await events(trace)).map((event) => event.kind)).toEqual([
			"ledger-save",
			"ledger-export",
			"ledger-save",
			"ledger-export",
		])
	})

	it("keeps failed incremental writes retryable", () => {
		process.env.KIMCHI_MEMORY_SQLITE_LEDGER = "1"
		const { root, store, trace } = prepare()
		const error = new Error("ledger unavailable")
		const attempts = vi.spyOn(store, "markHashes").mockImplementation(() => {
			throw error
		})
		const ledger = new CapturedHashLedger(new Set(), trace, store, root)
		ledger.mark(["new"])
		expect(() => ledger.save()).toThrow(error)
		expect(() => ledger.save()).toThrow(error)
		expect(attempts).toHaveBeenCalledTimes(2)
	})

	it("keeps the legacy JSON mode unchanged when the pilot flag is absent", async () => {
		const { root, store, trace } = prepare()
		writeFileSync(join(root, "captured-hashes.json"), JSON.stringify(["legacy"]))
		const ledger = new CapturedHashLedger(new Set(["legacy"]), trace)
		ledger.mark(["one"])
		ledger.save()
		expect(new Set(JSON.parse(readFileSync(join(root, "captured-hashes.json"), "utf-8")))).toEqual(
			new Set(["legacy", "one"]),
		)
		expect(store.hashes().size).toBe(0)
	})
})

describe("pilot deferred-prefix sizing", () => {
	it("uses smaller resumable prefixes without changing completion semantics", () => {
		prepare()
		process.env.KIMCHI_MEMORY_DEFERRED_BATCH_SIZE = "4"
		expect(deferredSupersedeBatchSize()).toBe(4)
		deferSupersede(
			"personal",
			Array.from({ length: 19 }, (_, i) => `observation-${i}`),
		)
		for (const expected of [4, 8, 12, 16, 19]) {
			const batch = readDeferredSupersedeBatch("personal")
			expect(batch.cursor).toBe(expected - batch.facts.length)
			expect(batch.facts.length).toBeLessThanOrEqual(4)
			completeDeferredSupersedePrefix("personal", batch.facts.length)
		}
		expect(existsSync(deferredSupersedePath("personal"))).toBe(false)
	})

	it("rejects invalid sizes and applies the same source-of-truth default", () => {
		expect(deferredSupersedeBatchSize({ KIMCHI_MEMORY_DEFERRED_BATCH_SIZE: "not-a-number" })).toBe(64)
		expect(deferredSupersedeBatchSize({ KIMCHI_MEMORY_DEFERRED_BATCH_SIZE: "0" })).toBe(64)
		expect(deferredSupersedeBatchSize({ KIMCHI_MEMORY_DEFERRED_BATCH_SIZE: "128" })).toBe(64)
		expect(deferredSupersedeBatchSize({})).toBe(64)
	})
})
