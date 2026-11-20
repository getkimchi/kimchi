import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteCaptureJobStore } from "./capture-jobs-sqlite.js"
import { exportCaptureState, migrateLegacyCaptureState } from "./capture-migration.js"
import type { CaptureJob, CaptureMessage } from "./capture-worker.js"

/** Optional offline migration drill. It creates only isolated temporary data;
 * no gateway, model, or embedding service is contacted. */
const root = mkdtempSync(join(tmpdir(), "kimchi-queue-scale-"))

function scaleCount(name: string, defaultValue: number): number {
	const value = Number(process.env[name] ?? defaultValue)
	assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`)
	return value
}

const pendingCount = scaleCount("KIMCHI_QUEUE_SCALE_JOBS", 100_000)
const hashCount = scaleCount("KIMCHI_QUEUE_SCALE_HASHES", 1_000_000)
const expectedBatches = Math.ceil((pendingCount + 2) / 500)

function message(i: number): CaptureMessage {
	return { role: "user", content: `durable fact ${i}` }
}

function job(i: number): CaptureJob {
	return { version: 2, messages: [message(i)], dedupeSession: `session-${i % 128}` }
}

const startedAt = Date.now()
try {
	mkdirSync(join(root, "pending"), { recursive: true })
	mkdirSync(join(root, "failed"), { recursive: true })
	const prepareStart = Date.now()
	for (let i = 0; i < pendingCount; i++) {
		writeFileSync(join(root, "pending", `job-${i}.json`), JSON.stringify(job(i)))
	}
	writeFileSync(join(root, "pending", "corrupt.json"), "{not-json")
	const failed = [
		{ version: 2 as const, messages: [message(pendingCount)], dedupeSession: "failed-one" },
		{ version: 2 as const, messages: [message(pendingCount + 1)], dedupeSession: "failed-two" },
	]
	for (const [index, record] of failed.entries()) {
		writeFileSync(join(root, "failed", `failed-job-${index}.json`), JSON.stringify(record))
	}
	const hashes = Array.from({ length: hashCount }, (_, i) => createHash("sha256").update(String(i)).digest("hex"))
	writeFileSync(join(root, "captured-hashes.json"), JSON.stringify(hashes))
	console.log(`[scale] generated legacy inputs in ${Date.now() - prepareStart}ms`)

	const migrateStart = Date.now()
	const { store, migration: audit } = createSqliteCaptureJobStore(root)
	assert.deepEqual(audit, {
		pendingImported: pendingCount,
		failedImported: 2,
		hashesImported: hashCount,
		batches: expectedBatches,
	})
	console.log(`[scale] initial import completed in ${Date.now() - migrateStart}ms`)
	const pendingStart = Date.now()
	assert.equal(store.pending(Number.MAX_SAFE_INTEGER).length, pendingCount)
	console.log(`[scale] verified ${pendingCount} pending records in ${Date.now() - pendingStart}ms`)
	assert.equal(store.count("failed"), 2)
	assert.equal(store.hashes().size, hashCount)
	assert.ok(JSON.stringify(store.pendingQueryPlan()).includes("jobs_state_mtime"))
	const failedJob = join(root, "failed", "failed-job-0.json")
	store.setState(failedJob, "pending")
	assert.ok(store.pending(Number.MAX_SAFE_INTEGER).includes(failedJob))
	store.setState(failedJob, "failed")
	assert.equal(store.count("failed"), 2)
	console.log(
		`[scale] initial import, indexed lookup, requeue and poison transitions in ${Date.now() - migrateStart}ms`,
	)

	const exportStart = Date.now()
	const exported = exportCaptureState(store, root)
	assert.equal(exported.jobs.length, pendingCount + 2)
	assert.equal(exported.capturedHashes.length, hashCount)
	console.log(`[scale] downgrade export in ${Date.now() - exportStart}ms`)

	store.reset()
	assert.equal(store.count(), 0)
	assert.equal(store.hashes().size, 0)
	const resetStart = Date.now()
	const second = migrateLegacyCaptureState(store, root, 500)
	assert.deepEqual(second, audit)
	assert.equal(migrateLegacyCaptureState(store, root, 500).pendingImported, pendingCount)
	assert.equal(migrateLegacyCaptureState(store, root, 500).failedImported, 2)
	store.close()

	const reopenStart = Date.now()
	const { store: reopened, migration: repeat } = createSqliteCaptureJobStore(root)
	assert.equal(repeat, undefined)
	assert.equal(reopened.pending(Number.MAX_SAFE_INTEGER).length, pendingCount)
	assert.equal(reopened.count("failed"), 2)
	assert.equal(reopened.hashes().size, hashCount)
	const exportedAgain = exportCaptureState(reopened, root)
	assert.equal(exportedAgain.jobs.length, exported.jobs.length)
	assert.equal(exportedAgain.capturedHashes.length, exported.capturedHashes.length)
	reopened.close()
	const report = {
		jobs: pendingCount,
		failedJobs: 2,
		hashes: hashCount,
		queriesIndexed: true,
		generateMs: prepareStart - startedAt,
		importMs: exportStart - migrateStart,
		exportMs: resetStart - exportStart,
		resetAndReimportMs: reopenStart - resetStart,
		reopenAndExportMs: Date.now() - reopenStart,
		totalMs: Date.now() - startedAt,
	}
	const reportPath = join(root, "scale-report.json")
	writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
	assert.ok(Date.now() - startedAt < 300_000, "migration scale benchmark exceeded 300 seconds")
	console.log(`[scale] reopened/verified in ${report.reopenAndExportMs}ms`)
	console.log(`PASS Bun queue scale with 100k jobs and 1M hashes in ${report.totalMs}ms`)
	console.log(JSON.stringify(report))
	if (process.env.KIMCHI_QUEUE_PRESERVE === "1") console.log(`scale report: ${reportPath}`)
} finally {
	if (process.env.KIMCHI_QUEUE_PRESERVE !== "1") rmSync(root, { recursive: true, force: true })
}
