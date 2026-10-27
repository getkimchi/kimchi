import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it.each(["memory", "sqlite"])("preserves per-account CAS, frozen batches and atomic rollback (%s)", {
	timeout: 30_000,
}, (mode) => {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-outbox-"))
	try {
		const driver = fileURLToPath(new URL("../../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
		const result = JSON.parse(execFileSync("bun", [driver, "outbox", dir, mode], { encoding: "utf8", timeout: 30_000 }))
		expect(result).toEqual({
			revisions: ["1", "2", "3"],
			cas: true,
			noOp: true,
			byteIsolation: true,
			binaryBatchOrder: true,
			readOnlyStatus: true,
			retryStatus: true,
			resumedStatus: true,
			invalidRetryRetained: true,
			corruptionRejected: true,
			forwardCompat: true,
			forwardBytesPreserved: true,
			hashMismatchRejected: true,
			admissionRejected: true,
			cumulativePreserved: true,
			markerPaging: true,
			kindImmutable: true,
			claimInheritance: true,
			claimUpdateRejected: true,
			correctionProgression: true,
			claimTargetIdentity: true,
			noNativeUpgrade: true,
			accountIsolation: true,
			frozenReplay: true,
			invalidAckRetained: true,
			observationRollback: true,
			batchRollback: true,
			ackRollback: true,
			leasePause: true,
			oldAckRetainedNewBatch: true,
			acknowledgedHistoryRetained: true,
			reopened: mode === "sqlite",
		})
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

it("freezes UTC protobuf timestamps and builds the next revision on the previous event ID", { timeout: 30_000 }, () => {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-outbox-transport-"))
	try {
		const driver = fileURLToPath(new URL("../../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
		const result = JSON.parse(
			execFileSync("bun", [driver, "outbox-transport", dir], { encoding: "utf8", timeout: 30_000 }),
		)
		const [coverage, pullRequest] = result.first.batch.events
		expect(coverage.observeTime).toBe("2026-10-24T00:00:00.123456789Z")
		expect(coverage.startedAt).toBe("2026-10-23T23:59:00Z")
		expect(coverage.correction.recordedAt).toBe("2026-10-23T23:30:00Z")
		expect(coverage.coverage.windowStartTime).toBe("2026-10-23T23:00:00.000000001Z")
		expect(coverage.coverage.windowEndTime).toBe("2026-10-23T23:30:00.000000002Z")
		expect(pullRequest.pullRequest).toMatchObject({
			createTime: "2026-10-23T08:00:00.123456789Z",
			closeTime: "2026-10-23T23:30:00Z",
			mergeTime: "2026-10-23T23:31:00Z",
		})
		expect(result.second.batch.events[0].baseEventId).toBe(coverage.id)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
