import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createSqliteCaptureJobStore, SqliteCaptureJobStore } from "./capture-jobs-sqlite.js"
import type { CaptureMessage } from "./capture-worker.js"
import { CapturedHashLedger } from "./commit.js"
import { createTraceRecorder, readDrainEvents } from "./trace.js"

const msg = (content: string): CaptureMessage => ({ role: "user", content })
const bun = Boolean(process.versions.bun)

describe.skipIf(!bun)("SQLite capture job store", () => {
	let root: string
	let store: ReturnType<typeof createSqliteCaptureJobStore>["store"] | undefined

	const previousLedgerFlag = process.env.KIMCHI_MEMORY_SQLITE_LEDGER
	const realHome = process.env.HOME
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "kimchi-sqlite-jobs-"))
		process.env.HOME = root
		process.env.KIMCHI_MEMORY_SQLITE_LEDGER = previousLedgerFlag
		mkdirSync(join(root, "pending"), { recursive: true })
	})
	afterEach(() => {
		store?.close()
		process.env.HOME = realHome
		if (previousLedgerFlag === undefined) delete process.env.KIMCHI_MEMORY_SQLITE_LEDGER
		else process.env.KIMCHI_MEMORY_SQLITE_LEDGER = previousLedgerFlag
		rmSync(root, { recursive: true, force: true })
		store = undefined
	})

	it("migrates legacy state once through the factory boundary", () => {
		const file = join(root, "pending", "import.json")
		writeFileSync(file, JSON.stringify({ messages: [msg("one")] }))
		writeFileSync(join(root, "captured-hashes.json"), JSON.stringify(["h1", "h1", "h2"]))
		const created = createSqliteCaptureJobStore(root)
		store = created.store
		expect(created.migration).toEqual({ pendingImported: 1, failedImported: 0, hashesImported: 3, batches: 1 })
		expect(store.pending(10)).toEqual([file])
		expect(store.hashes()).toEqual(new Set(["h1", "h2"]))
		store.close()
		const reopened = createSqliteCaptureJobStore(root)
		store = reopened.store
		expect(reopened.migration).toBeUndefined()
		expect(store.pending(10)).toEqual([file])
	})

	it("resumes an interrupted migration with existing jobs and hashes", () => {
		const first = join(root, "pending", "one.json")
		const second = join(root, "pending", "two.json")
		writeFileSync(first, JSON.stringify({ messages: [msg("one")] }))
		writeFileSync(second, JSON.stringify({ messages: [msg("two")] }))
		store = new SqliteCaptureJobStore(root)
		store.upsert(first, { messages: [msg("one")] })
		store.markHashes(["committed-before-interruption"])
		expect(store.legacyCaptureMigrationComplete()).toBe(false)
		store.close()
		const reopened = createSqliteCaptureJobStore(root)
		store = reopened.store
		expect(reopened.migration).toMatchObject({ pendingImported: 2, failedImported: 0 })
		expect(store.pending(10)).toEqual([first, second])
		expect(store.hashes().has("committed-before-interruption")).toBe(true)
		expect(store.legacyCaptureMigrationComplete()).toBe(true)
	})

	it("keeps stale pending cleanup inside an explicit store root", () => {
		const otherRoot = mkdtempSync(join(root, "other-root-"))
		const created = createSqliteCaptureJobStore(otherRoot)
		store = created.store
		const failedFile = join(otherRoot, "failed", "moved.json")
		const unrelatedPendingFile = join(root, "pending", "moved.json")
		store.setState(failedFile, "pending", { messages: [msg("moved")] })
		store.upsert(unrelatedPendingFile, { messages: [msg("unrelated")] })
		store.setState(failedFile, "failed")
		expect(store.stateOf(failedFile)).toBe("failed")
		expect(store.stateOf(unrelatedPendingFile)).toBe("pending")
	})

	it("writes incremental hashes with a compatible per-wave snapshot", async () => {
		process.env.KIMCHI_MEMORY_SQLITE_LEDGER = "1"
		writeFileSync(join(root, "captured-hashes.json"), JSON.stringify(["legacy"]))
		const created = createSqliteCaptureJobStore(root)
		store = created.store
		const trace = createTraceRecorder()
		const ledger = new CapturedHashLedger(new Set(store.hashes()), trace, store, root)
		ledger.mark(["one"])
		ledger.save()
		ledger.exportSnapshot()
		expect(store.hashes()).toEqual(new Set(["legacy", "one"]))
		expect(new Set(JSON.parse(readFileSync(join(root, "captured-hashes.json"), "utf-8")))).toEqual(
			new Set(["legacy", "one"]),
		)
		await trace?.flush?.()
		expect(readDrainEvents(basename(trace?.file ?? "")).map((event) => event.kind)).toEqual([
			"ledger-save",
			"ledger-export",
		])
	})

	it("hydrates state on restart, honors exclusions, and uses the pending index", () => {
		const first = join(root, "pending", "one.json")
		const second = join(root, "pending", "two.json")
		writeFileSync(first, JSON.stringify({ messages: [msg("one")] }))
		writeFileSync(second, JSON.stringify({ messages: [msg("two")] }))
		const old = Date.now() - 1000
		const newer = Date.now()
		const { utimesSync } = require("node:fs") as typeof import("node:fs")
		utimesSync(first, old, old)
		utimesSync(second, newer, newer)
		const created = createSqliteCaptureJobStore(root)
		store = created.store
		store.upsert(first, { messages: [msg("one")] })
		store.upsert(second, { messages: [msg("two")] })
		store.upsert(join(root, "pending", "missing.json"), { messages: [msg("missing")] }, "pending", old - 1)
		store.markHashes(["h1", "h1", "h2"])
		store.close()
		store = createSqliteCaptureJobStore(root).store
		expect(store.pending(1)).toEqual([first])
		expect(store.pending(1, new Set([first]))).toEqual([second])
		expect(store.hashes()).toEqual(new Set(["h1", "h2"]))
		expect(JSON.stringify(store.pendingQueryPlan())).toContain("jobs_state_mtime")
		store.setState(second, "failed")
		expect(store.pending(10)).toEqual([first])
	})
})
