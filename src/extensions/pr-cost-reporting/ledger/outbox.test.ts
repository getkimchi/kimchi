import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { createMemoryRecords } from "./memory-records.js"
import { effectiveClaims, effectiveClaimsAsync, outboxDeliveryStatus } from "./outbox.js"
import { useBackendFactory } from "./records.js"

/** Seed entities x revisions of claim-shaped events, with blocked rows interleaved. */
function seedClaims(backend: ReturnType<typeof createMemoryRecords>, entities: string[]): void {
	backend.tx(() => {
		for (let index = 0; index < entities.length; index++) {
			const entityId = entities[index]
			for (let revision = 1; revision <= 3; revision++) {
				const event = {
					id: `ev-${index}-${revision}`,
					source: "kimchi",
					entityId,
					revision: String(revision),
					startedAt: `2026-01-0${revision}T00:00:00.000Z`,
					work: {},
				}
				const body = Buffer.from(JSON.stringify(event))
				backend.insertOutboxEvent({
					id: `ev-${index}-${revision}`,
					accountKey: "account",
					entityId,
					kind: "work",
					body,
					hash: createHash("sha256").update(body).digest("hex"),
					createdAt: index * 10 + revision,
					ackedAt: null,
					blocked: revision === 2 && index % 7 === 0 ? "conflict" : "",
				})
			}
		}
	})
}

it("the breathing claim resolution matches the synchronous one across chunk and page boundaries", async () => {
	const backend = createMemoryRecords()
	const entities = Array.from({ length: 600 }, (_, index) => `entity-${index}`)
	seedClaims(backend, entities)
	const sync = effectiveClaims(backend, "account", entities)
	let stretches = 0
	const breathed = await effectiveClaimsAsync(
		backend,
		"account",
		entities,
		async () => {
			stretches++
		},
		() => {},
	)
	expect([...breathed.entries()]).toEqual([...sync.entries()])
	// 600 entities cross the 500-chunk boundary; 1,800 rows cross the 256-row page
	// boundary repeatedly — the stretch must actually fire between them.
	expect(stretches).toBeGreaterThanOrEqual(8)
})

it("sqlite: the rowid cursor pages claim history to the same result (bun driver)", () => {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-claims-parity-"))
	try {
		const driver = fileURLToPath(new URL("../../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
		const result = JSON.parse(
			execFileSync("bun", [driver, "claims-parity", dir], { encoding: "utf8", timeout: 60_000 }),
		)
		expect(result).toMatchObject({ same: true, entities: 600 })
		expect(result.stretches).toBeGreaterThanOrEqual(8)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

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
			conflictSetAside: true,
			conflictRebased: true,
			acknowledgedHistoryRetained: true,
			reopened: mode === "sqlite",
		})
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

/** Seed every account shape the delivery-status projection must distinguish. */
function seedDeliveryShapes(backend: ReturnType<typeof createMemoryRecords>): void {
	const event = (accountKey: string, index: number) => {
		const id = `ev-${accountKey}-${index}`
		const body = Buffer.from(JSON.stringify({ id, entityId: id }))
		return {
			id,
			accountKey,
			entityId: id,
			kind: "work",
			body,
			hash: createHash("sha256").update(body).digest("hex"),
			createdAt: index,
			ackedAt: null as number | null,
			blocked: "",
		}
	}
	backend.tx(() => {
		for (let index = 0; index < 3; index++) backend.insertOutboxEvent(event("account-pending", index))
		for (let index = 0; index < 2; index++) {
			const acked = event("account-acked", index)
			backend.insertOutboxEvent(acked)
			if (!backend.ackOutboxEvent("account-acked", acked.id, acked.hash, index)) throw new Error("ack failed")
		}
		for (let index = 0; index < 2; index++) {
			const blocked = event("account-blocked", index)
			backend.insertOutboxEvent(blocked)
			if (!backend.blockOutboxEvent("account-blocked", blocked.id, blocked.hash, "test"))
				throw new Error("block failed")
		}
		for (let index = 0; index < 3; index++) {
			const mixed = event("account-mixed", index)
			backend.insertOutboxEvent(mixed)
			if (index === 0 && !backend.ackOutboxEvent("account-mixed", mixed.id, mixed.hash, index))
				throw new Error("ack failed")
			if (index === 1 && !backend.blockOutboxEvent("account-mixed", mixed.id, mixed.hash, "test"))
				throw new Error("block failed")
		}
		for (let index = 0; index < 2; index++) backend.insertOutboxEvent(event("account-batched", index))
		for (let index = 0; index < 3; index++)
			backend.insertOutboxBatch({
				id: `batch-${index}`,
				accountKey: "account-batched",
				body: Buffer.alloc(0),
				eventIds: [],
				createdAt: index,
				orderKey: "",
			})
		backend.insertOutboxBatch({
			id: "batch-only",
			accountKey: "account-batchonly",
			body: Buffer.alloc(0),
			eventIds: [],
			createdAt: 0,
			orderKey: "",
		})
	})
}

it("the delivery-only status is the full status projection across every account shape", () => {
	const backend = createMemoryRecords()
	seedDeliveryShapes(backend)
	const full = backend.outboxStatus().map((status) => ({
		accountKey: status.accountKey,
		sendable: status.sendable > 0,
		hasBatch: status.batches > 0,
		firstBatchId: status.firstBatchId,
	}))
	const delivery = backend.outboxDeliveryStatus()
	// The parity guard: the optimized read may drop no account and flip no field.
	expect(delivery).toEqual(full)
	// The shapes that make the guard load-bearing, pinned explicitly.
	expect(new Map(delivery.map((status) => [status.accountKey, status]))).toEqual(
		new Map([
			["account-pending", { accountKey: "account-pending", sendable: true, hasBatch: false, firstBatchId: null }],
			["account-acked", { accountKey: "account-acked", sendable: false, hasBatch: false, firstBatchId: null }],
			["account-blocked", { accountKey: "account-blocked", sendable: false, hasBatch: false, firstBatchId: null }],
			["account-mixed", { accountKey: "account-mixed", sendable: true, hasBatch: false, firstBatchId: null }],
			["account-batched", { accountKey: "account-batched", sendable: true, hasBatch: true, firstBatchId: "batch-0" }],
			[
				"account-batchonly",
				{ accountKey: "account-batchonly", sendable: false, hasBatch: true, firstBatchId: "batch-only" },
			],
		]),
	)
})

it("delivery status reads and enriches retry state in one backend transaction", () => {
	const backend = createMemoryRecords()
	seedDeliveryShapes(backend)
	const batchId = "11111111-1111-4111-8111-111111111111"
	backend.insertOutboxBatch({
		id: batchId,
		accountKey: "account-retry",
		body: Buffer.alloc(0),
		eventIds: [],
		createdAt: 0,
		orderKey: "",
	})
	backend.putNote(
		"pr-cost-delivery",
		"account-retry",
		JSON.stringify({ batchId, attempts: 4, retryAt: 12345, error: "temporary" }),
	)
	const transact = backend.tx.bind(backend)
	let transactions = 0
	backend.tx = (fn) => {
		transactions++
		return transact(fn)
	}
	useBackendFactory(() => backend)
	try {
		const batched = outboxDeliveryStatus("unused").find((status) => status.accountKey === "account-retry")
		expect(batched).toMatchObject({
			firstBatchId: batchId,
			retry: { batchId, attempts: 4, retryAt: 12345, error: "temporary" },
		})
		expect(transactions).toBe(1)
	} finally {
		useBackendFactory(null)
	}
})

it.each([
	"memory",
	"sqlite",
])("the delivery-only status survives a cold reopen and its probes stay index-bounded (%s)", {
	timeout: 30_000,
}, (mode) => {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-delivery-status-"))
	try {
		const driver = fileURLToPath(new URL("../../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
		const result = JSON.parse(
			execFileSync("bun", [driver, "delivery-status", dir, mode], { encoding: "utf8", timeout: 60_000 }),
		)
		expect(result).toMatchObject({ same: true, accounts: 6 })
		expect(result.reopenedSame).toBe(mode === "sqlite" ? true : undefined)
		if (mode === "sqlite") {
			// The probes must run on the covering indexes, never a table scan.
			expect(result.plans.sendable.join("\n")).toContain("outbox_pending_cover")
			expect(result.plans.firstBatch.join("\n")).toContain("outbox_batches_by_account")
		}
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
