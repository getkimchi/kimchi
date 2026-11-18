/**
 * Durable capture-job index. Job files remain the compatibility/staging
 * format; this store supplies indexed pending lookup, state transitions,
 * migration, and captured-hash persistence without per-job directory scans.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { defaultMemoryDir } from "./backend.js"
import { createSqliteCaptureJobStore } from "./capture-jobs-sqlite.js"
import { type CaptureMigrationProgress, migrateLegacyCaptureState } from "./capture-migration.js"
import type { CaptureJob } from "./capture-worker.js"

export type CaptureJobState = "pending" | "failed" | "complete"

export interface CaptureJobRecord {
	jobFile: string
	job: CaptureJob
	state: CaptureJobState
	mtimeMs: number
}

export interface CaptureJobStore {
	upsert(jobFile: string, job: CaptureJob, state?: CaptureJobState, mtimeMs?: number): void
	upsertMany(records: readonly CaptureJobRecord[]): void
	stateOf(jobFile: string): CaptureJobState | undefined
	pending(limit: number, exclude?: ReadonlySet<string>): string[]
	count(state?: CaptureJobState): number
	hashes(): Set<string>
	markHashes(hashes: Iterable<string>): void
	legacyCaptureMigrationComplete?(): boolean
	markLegacyCaptureMigrationComplete?(): void
	setState(jobFile: string, state: CaptureJobState, job?: CaptureJob, mtimeMs?: number): void
	oldestPendingAgeMs(now: number): number | undefined
	reset(): void
	close(): void
}

/** In-memory implementation used by Node tests and as the migration baseline. */
export class MemoryCaptureJobStore implements CaptureJobStore {
	protected readonly records = new Map<string, CaptureJobRecord>()
	protected readonly committedHashes = new Set<string>()

	upsert(jobFile: string, job: CaptureJob, state: CaptureJobState = "pending", mtimeMs?: number): void {
		const existing = this.records.get(jobFile)
		this.records.set(jobFile, {
			jobFile,
			job,
			state,
			mtimeMs: mtimeMs ?? existing?.mtimeMs ?? statSync(jobFile).mtimeMs,
		})
	}

	upsertMany(records: readonly CaptureJobRecord[]): void {
		for (const record of records) this.records.set(record.jobFile, { ...record })
	}

	pending(limit: number, exclude?: ReadonlySet<string>): string[] {
		return [...this.records.values()]
			.filter((record) => record.state === "pending" && existsSync(record.jobFile) && !exclude?.has(record.jobFile))
			.sort((a, b) => a.mtimeMs - b.mtimeMs || a.jobFile.localeCompare(b.jobFile))
			.slice(0, limit)
			.map((record) => record.jobFile)
	}

	count(state?: CaptureJobState): number {
		if (!state) return this.records.size
		return [...this.records.values()].filter((record) => record.state === state).length
	}

	stateOf(jobFile: string): CaptureJobState | undefined {
		return this.records.get(jobFile)?.state
	}

	hashes(): Set<string> {
		return new Set(this.committedHashes)
	}

	markHashes(hashes: Iterable<string>): void {
		for (const hash of hashes) this.committedHashes.add(hash)
	}

	setState(jobFile: string, state: CaptureJobState, job?: CaptureJob, mtimeMs?: number): void {
		const existing = this.records.get(jobFile)
		this.records.set(jobFile, {
			jobFile,
			job: job ?? existing?.job ?? readCaptureJobFile(jobFile),
			state,
			mtimeMs: mtimeMs ?? existing?.mtimeMs ?? (existsSync(jobFile) ? statSync(jobFile).mtimeMs : Date.now()),
		})
	}

	oldestPendingAgeMs(now: number): number | undefined {
		const pendingTimes = [...this.records.values()]
			.filter((record) => record.state === "pending")
			.map((record) => record.mtimeMs)
		return pendingTimes.length === 0 ? undefined : now - Math.min(...pendingTimes)
	}

	reset(): void {
		this.records.clear()
		this.committedHashes.clear()
	}

	close(): void {}
}

/** Read a compatibility job payload from disk. Exported for migration tests. */
export function readCaptureJobFile(jobFile: string): CaptureJob {
	return JSON.parse(readFileSync(jobFile, "utf-8")) as CaptureJob
}

export function pendingJobDir(root = defaultMemoryDir()): string {
	return join(root, "pending")
}

export function failedJobDir(root = defaultMemoryDir()): string {
	return join(root, "failed")
}

/** Restore a file's mtime after a compatibility rewrite. */
export function rewriteCaptureJobFile(jobFile: string, value: unknown, mtimeMs = statSync(jobFile).mtimeMs): void {
	const tmp = `${jobFile}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify(value, null, 0)}\n`, "utf-8")
	renameSync(tmp, jobFile)
	utimesSync(jobFile, new Date(), new Date(mtimeMs))
}

/** Legacy JSONL downgrade/import representation. */
export function jobRecordFromFile(jobFile: string, state: CaptureJobState = "pending"): CaptureJobRecord {
	return { jobFile, job: readCaptureJobFile(jobFile), state, mtimeMs: statSync(jobFile).mtimeMs }
}

export function listLegacyJobFiles(root = defaultMemoryDir()): string[] {
	const pending = pendingJobDir(root)
	if (!existsSync(pending)) return []
	return readdirSync(pending)
		.filter((name) => name.endsWith(".json"))
		.map((name) => join(pending, name))
}

export function listFailedJobFiles(root = defaultMemoryDir()): string[] {
	const failed = failedJobDir(root)
	if (!existsSync(failed)) return []
	return readdirSync(failed)
		.filter((name) => name.endsWith(".json"))
		.map((name) => join(failed, name))
}

export function jobKeyFromFile(jobFile: string): string {
	return basename(jobFile, ".json")
}

const stores = new Map<string, CaptureJobStore>()

/** Return the shared store for a memory root (SQLite on Bun, in-memory on
 * Node for unit tests). */
export function getCaptureJobStore(root = defaultMemoryDir(), onProgress?: CaptureMigrationProgress): CaptureJobStore {
	const existing = stores.get(root)
	if (existing) return existing
	let created: CaptureJobStore
	if (process.versions.bun) {
		// Static import: the compiled Bun executable cannot resolve a relative
		// require() at runtime. Constructing the database remains Bun-only.
		created = createSqliteCaptureJobStore(root, onProgress).store
	} else {
		created = new MemoryCaptureJobStore()
		if (created.count() === 0) migrateLegacyCaptureState(created, root, 500, undefined, onProgress)
	}
	stores.set(root, created)
	return created
}
