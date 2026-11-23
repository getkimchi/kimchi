import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { jobKeyFromFile, jobRecordFromFile, MemoryCaptureJobStore } from "./capture-jobs.js"
import { type CaptureMigrationProgress, exportCaptureState, migrateLegacyCaptureState } from "./capture-migration.js"
import type { CaptureMessage } from "./capture-worker.js"
import { defaultMemoryDir } from "./config.js"

const msg = (content: string): CaptureMessage => ({ role: "user", content })

describe("capture job store and legacy migration", () => {
	const realHome = process.env.HOME
	let home: string

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "kimchi-capture-jobs-"))
		process.env.HOME = home
		mkdirSync(defaultMemoryDir(), { recursive: true })
	})
	afterEach(() => {
		process.env.HOME = realHome
		rmSync(home, { recursive: true, force: true })
	})

	it("returns the oldest pending jobs, honors exclude before limit, and reports age", () => {
		const store = new MemoryCaptureJobStore()
		const now = Date.now()
		const pending = `${defaultMemoryDir()}/pending`
		mkdirSync(pending, { recursive: true })
		const first = join(pending, "old.json")
		const second = join(pending, "new.json")
		writeFileSync(first, JSON.stringify({ messages: [msg("old")] }))
		writeFileSync(second, JSON.stringify({ messages: [msg("new")] }))
		const oldTime = new Date(now - 10_000)
		const newTime = new Date(now - 1_000)
		const { utimesSync } = require("node:fs") as typeof import("node:fs")
		utimesSync(first, oldTime, oldTime)
		utimesSync(second, newTime, newTime)
		store.upsert(first, { messages: [msg("old")] }, "pending", oldTime.getTime())
		store.upsert(second, { messages: [msg("new")] }, "pending", newTime.getTime())
		expect(store.pending(1, new Set([first]))).toEqual([second])
		expect(store.pending(1)).toEqual([first])
		expect(store.oldestPendingAgeMs(now)).toBe(10_000)
		expect(store.count("pending")).toBe(2)
		expect(jobKeyFromFile(first)).toBe("old")
	})

	it("commits each bounded batch before reading the next one", () => {
		const dir = join(defaultMemoryDir(), "pending")
		mkdirSync(dir, { recursive: true })
		for (let index = 0; index < 1001; index++) {
			writeFileSync(
				join(dir, `job-${String(index).padStart(4, "0")}.json`),
				JSON.stringify({ messages: [msg(`fact ${index}`)] }),
			)
		}

		let reads = 0
		const batchesAtCommit: number[] = []
		class BatchTrackingStore extends MemoryCaptureJobStore {
			override upsertMany(records: Parameters<MemoryCaptureJobStore["upsertMany"]>[0]): void {
				batchesAtCommit.push(reads)
				super.upsertMany(records)
			}
		}
		const audit = migrateLegacyCaptureState(new BatchTrackingStore(), defaultMemoryDir(), 500, (file, state) => {
			reads += 1
			return jobRecordFromFile(file, state)
		})
		expect(audit.pendingImported).toBe(1001)
		expect(audit.batches).toBe(3)
		expect(batchesAtCommit).toEqual([500, 1000, 1001])
		expect(reads).toBe(1001)
	})

	it("imports captured hashes in bounded batches with progress", () => {
		const dir = defaultMemoryDir()
		writeFileSync(
			join(dir, "captured-hashes.json"),
			JSON.stringify(Array.from({ length: 1001 }, (_, i) => `hash-${i}`)),
		)
		const batches: number[] = []
		class HashTrackingStore extends MemoryCaptureJobStore {
			override markHashes(hashes: Iterable<string>): void {
				const batch = [...hashes]
				batches.push(batch.length)
				super.markHashes(batch)
			}
		}
		const progress: Parameters<CaptureMigrationProgress>[] = []
		const audit = migrateLegacyCaptureState(new HashTrackingStore(), dir, 500, undefined, (phase, completed) => {
			progress.push([phase, completed])
		})
		expect(audit.hashesImported).toBe(1001)
		expect(batches).toEqual([500, 500, 1])
		expect(progress).toEqual([
			["hashes", 500],
			["hashes", 1000],
			["hashes", 1001],
		])
	})

	it("imports legacy jobs/hashes idempotently and exports compatible state", () => {
		mkdirSync(defaultMemoryDir(), { recursive: true })
		mkdirSync(join(defaultMemoryDir(), "pending"), { recursive: true })
		mkdirSync(join(defaultMemoryDir(), "failed"), { recursive: true })
		const pending = join(defaultMemoryDir(), "pending", "one.json")
		const failed = join(defaultMemoryDir(), "failed", "two.json")
		writeFileSync(pending, JSON.stringify({ version: 2, messages: [msg("one")] }))
		writeFileSync(failed, JSON.stringify({ messages: [msg("two")] }))
		writeFileSync(join(defaultMemoryDir(), "captured-hashes.json"), JSON.stringify(["h1", "h1", "h2"]))
		const store = new MemoryCaptureJobStore()
		const firstAudit = migrateLegacyCaptureState(store, defaultMemoryDir(), 1)
		expect(firstAudit).toMatchObject({ pendingImported: 1, failedImported: 1, hashesImported: 3, batches: 2 })
		migrateLegacyCaptureState(store, defaultMemoryDir(), 1)
		expect(store.pending(10)).toEqual([pending])
		expect(store.count("failed")).toBe(1)
		expect(store.hashes()).toEqual(new Set(["h1", "h2"]))
		const exported = exportCaptureState(store)
		expect(exported.jobs).toHaveLength(2)
		expect(exported.capturedHashes).toEqual(["h1", "h2"])
		expect(readFileSync(pending, "utf-8")).toContain("one")
	})
})
