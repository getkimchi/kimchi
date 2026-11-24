/**
 * Idempotent import of legacy pending/failed job JSON and captured hashes.
 * Sources are never deleted during migration; rollback is a simple artifact
 * restore or downgrade export. Hash collisions merge rather than duplicate.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { defaultMemoryDir } from "./backend.js"
import {
	type CaptureJobRecord,
	type CaptureJobStore,
	jobRecordFromFile,
	listFailedJobFiles,
	listLegacyJobFiles,
} from "./capture-jobs.js"

export type CaptureMigrationProgress = (phase: "jobs" | "hashes", completed: number) => void

export interface CaptureMigrationAudit {
	pendingImported: number
	failedImported: number
	hashesImported: number
	batches: number
}

/** Import in bounded batches so a partial run is cheap to resume safely. */
export function migrateLegacyCaptureState(
	store: CaptureJobStore,
	root = defaultMemoryDir(),
	batchSize = 500,
	loadRecord = jobRecordFromFile,
	onProgress?: CaptureMigrationProgress,
): CaptureMigrationAudit {
	const audit: CaptureMigrationAudit = { pendingImported: 0, failedImported: 0, hashesImported: 0, batches: 0 }
	if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new Error("batchSize must be a positive integer")
	// Read/commit batches incrementally: large backlog captures must not be
	// retained as a second full in-memory queue while SQLite is populated.
	const importJobs = (files: readonly string[], state: "pending" | "failed"): void => {
		const records: Array<CaptureJobRecord> = []
		const flush = (): void => {
			if (records.length === 0) return
			store.upsertMany(records)
			audit.batches += 1
			audit[state === "pending" ? "pendingImported" : "failedImported"] += records.length
			onProgress?.("jobs", audit.pendingImported + audit.failedImported)
			records.length = 0
		}
		for (const file of files) {
			try {
				records.push(loadRecord(file, state))
				if (records.length === batchSize) flush()
			} catch (err) {
				console.error(
					`[memory-capture] skipping unparseable legacy job during migration: ${err instanceof Error ? err.message : err}`,
				)
			}
		}
		flush()
	}
	importJobs(listLegacyJobFiles(root), "pending")
	importJobs(listFailedJobFiles(root), "failed")
	const ledger = join(root, "captured-hashes.json")
	if (existsSync(ledger)) {
		try {
			const values: unknown = JSON.parse(readFileSync(ledger, "utf-8"))
			if (Array.isArray(values)) {
				const strings = values.filter((value): value is string => typeof value === "string")
				for (let start = 0; start < strings.length; start += batchSize) {
					const batch = strings.slice(start, start + batchSize)
					store.markHashes(batch)
					audit.hashesImported += batch.length
					onProgress?.("hashes", audit.hashesImported)
				}
			}
		} catch (err) {
			console.error(
				`[memory-capture] unreadable captured-hash ledger, importing no hashes: ${err instanceof Error ? err.message : err}`,
			)
		}
	}
	store.markLegacyCaptureMigrationComplete?.()
	return audit
}

/** Lossless JSONL export for backup and downgrade from any queue implementation. */
export function exportCaptureState(
	store: CaptureJobStore,
	root = defaultMemoryDir(),
): {
	jobs: CaptureJobRecord[]
	capturedHashes: string[]
} {
	const jobs = [...store.pending(Number.MAX_SAFE_INTEGER).map((job) => jobRecordFromFile(job, "pending"))]
	for (const file of listFailedJobFiles(root)) jobs.push(jobRecordFromFile(file, "failed"))
	return { jobs, capturedHashes: [...store.hashes()] }
}
