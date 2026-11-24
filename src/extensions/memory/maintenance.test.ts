import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { historyDbPath } from "./backend.js"
import {
	auditMemory,
	dedupeMemory,
	maintainMemory,
	rollbackMaintenance,
	type SnapshotRow,
	type SnapshotStore,
	type SnapshotValue,
} from "./maintenance.js"
import { readMemoryMetadata } from "./metadata.js"

interface Row {
	id: string
	memory: string
	metadata?: unknown
}

class Backend {
	constructor(public rows: Row[]) {}

	writeCalls = 0
	updateCalls = 0
	failAfterWrite?: number
	history: Array<Record<string, SnapshotValue>> = [
		{ id: 1, memory_id: "alpha-old", previous_value: "old preference", new_value: "new preference", raw: [1, 0, 0, 0] },
	]

	async getAll() {
		return {
			results: this.rows.map((row) => ({
				...row,
				metadata: row.metadata === undefined ? undefined : readMemoryMetadata(row.metadata, row.memory),
			})),
		}
	}

	async search() {
		return this.rows.map((row) => ({ ...row, score: 0.6 }))
	}

	async delete(id: string) {
		const index = this.rows.findIndex((row) => row.id === id)
		if (index >= 0) {
			this.rows.splice(index, 1)
			this.recordWrite()
		}
	}

	async update(id: string, options: { metadata?: Record<string, unknown> }) {
		const row = this.rows.find((row) => row.id === id)
		if (!row) throw new Error("missing fact")
		Object.assign(row, { metadata: options.metadata })
		this.updateCalls++
		this.recordWrite()
	}

	private recordWrite() {
		this.writeCalls++
		if (this.failAfterWrite === this.writeCalls) throw new Error("injected maintenance failure")
	}
}

function snapshotStore(backend: Backend): SnapshotStore {
	return {
		readRows: () =>
			backend.rows.map((row) => ({
				id: row.id,
				vector: [1, 0, 0, 0],
				payload: { data: row.memory, user_id: "kimchi", metadata: row.metadata },
			})),
		restoreRows: (_dbPath, rows) => {
			const restored = rows.map((row) => ({
				id: row.id,
				memory: String(row.payload.data),
				metadata: row.payload.metadata,
			}))
			backend.rows.splice(0, backend.rows.length, ...restored)
		},
		readTables: () => [
			{
				name: "memory_history",
				schema:
					"CREATE TABLE IF NOT EXISTS memory_history (memory_id TEXT, previous_value TEXT, new_value TEXT, raw BLOB)",
				rows: backend.history.map((row) => ({ ...row })),
			},
		],
		restoreTables: (_dbPath, tables) => {
			backend.history = tables.find((table) => table.name === "memory_history")?.rows.map((row) => ({ ...row })) ?? []
		},
	}
}

const metadata = { version: 1, kind: "semantic", source: "extracted", normalizedTextHash: "abc" }

describe("memory maintenance", () => {
	let root: string
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "kimchi-maintenance-"))
	})
	afterEach(() => rmSync(root, { recursive: true, force: true }))

	function options(
		rows = [
			{ id: "alpha-old", memory: "Alpha convention", metadata },
			{ id: "alpha-copy", memory: " ALPHA  convention" },
			{ id: "first-fix", memory: "fix pnpm locks before merging" },
			{ id: "second-fix", memory: "fix pnpm locks before merging carefully" },
			{ id: "distinct", memory: "a distinct durable decision" },
		],
	) {
		const backend = new Backend(rows)
		return { dbPath: join(root, "memory.db"), backend, memoryRoot: root, snapshotStore: snapshotStore(backend) }
	}

	it("audits normalized duplicates, near clusters, and metadata coverage without mutating", async () => {
		const result = await auditMemory(options().backend)
		expect(result).toMatchObject({
			raw: 5,
			exactUnique: 5,
			normalizedUnique: 4,
			normalizedDuplicates: 1,
			duplicateGroups: 1,
			nearClusters: 1,
			metadataCount: 1,
			normalizedHashCount: 1,
		})
		expect(result.groups).toEqual([
			{ canonicalId: "alpha-old", ids: ["alpha-old", "alpha-copy"], normalizedText: "alpha convention" },
		])
	})

	it("creates a checked row snapshot before deleting only exact normalized duplicates", async () => {
		const opts = options()
		const result = await dedupeMemory(opts)
		const manifestPath = result.checkpoint

		expect(opts.backend.rows.map((row) => row.id)).toEqual(["alpha-old", "first-fix", "second-fix", "distinct"])
		expect(opts.backend.rows[0]?.metadata).toMatchObject({ canonical: true, supportIds: ["alpha-copy"] })
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
			source: string
			files: Array<{ source: string; snapshot: string; sha256: string }>
		}
		expect(manifest.files).toHaveLength(1)
		const file = manifest.files[0]
		expect(file).toBeDefined()
		if (!file) throw new Error("snapshot manifest has no vector export")
		const snapshot = JSON.parse(readFileSync(file.snapshot, "utf-8")) as SnapshotRow[]
		expect(snapshot.map((row) => row.id).sort()).toEqual(
			["alpha-old", "alpha-copy", "first-fix", "second-fix", "distinct"].sort(),
		)
		expect(snapshot.find((row) => row.id === "alpha-old")?.vector).toEqual([1, 0, 0, 0])
		expect(snapshot.find((row) => row.id === "alpha-old")?.payload).toMatchObject({
			data: "Alpha convention",
			user_id: "kimchi",
		})
		expect(existsSync(manifestPath)).toBe(true)
		expect(result.audit.normalizedDuplicates).toBe(0)

		await dedupeMemory(opts)
		expect(opts.backend.rows).toHaveLength(4)
	})

	it("uses row content for snapshot identity and records the capture lock root", async () => {
		const opts = options()
		const first = await maintainMemory(opts)
		const manifest = JSON.parse(readFileSync(first.checkpoint, "utf-8")) as { lockRoot?: string }
		expect(manifest.lockRoot).toBe(root)
		const distinct = opts.backend.rows[4]
		if (!distinct) throw new Error("test fixture has no distinct fact")
		distinct.memory = "a revised durable decision"

		const second = await dedupeMemory(opts)
		expect(second.checkpoint).not.toBe(first.checkpoint)
		const snapshotPath = (
			JSON.parse(readFileSync(second.checkpoint, "utf-8")) as { files: Array<{ snapshot: string }> }
		).files[0]?.snapshot
		if (!snapshotPath) throw new Error("snapshot manifest has no vector export")
		const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as SnapshotRow[]
		expect(snapshot.find((row) => row.id === "distinct")?.payload.data).toBe("a revised durable decision")
	})

	it("refuses to restore a checkpoint into a different store", async () => {
		const opts = options()
		const { checkpoint } = await dedupeMemory(opts)
		await expect(
			rollbackMaintenance(checkpoint, opts.backend, { ...opts, dbPath: join(root, "other.db") }),
		).rejects.toThrow("checkpoint belongs to a different memory store")
		expect(opts.backend.rows).toHaveLength(4)
	})

	it("resumes a fault after 25% of writes without reapplying canonical metadata", async () => {
		const opts = options([
			{ id: "canon-one", memory: "Use pnpm" },
			{ id: "copy-one", memory: " use PNPM " },
			{ id: "canon-two", memory: "Prefer vim" },
			{ id: "copy-two", memory: "prefer VIM" },
			{ id: "distinct", memory: "a different fact" },
		])
		opts.backend.failAfterWrite = 1
		await expect(dedupeMemory(opts)).rejects.toThrow("injected maintenance failure")
		expect(opts.backend.writeCalls).toBe(1)
		const snapshotId = readdirSync(join(root, "maintenance"))[0]
		if (!snapshotId) throw new Error("missing maintenance checkpoint")
		const manifest = JSON.parse(readFileSync(join(root, "maintenance", snapshotId, "manifest.json"), "utf-8")) as {
			status: string
			expectedHashes?: Record<string, string>
		}
		expect(manifest.status).toBe("snapshot")
		expect(manifest.expectedHashes).toBeUndefined()

		opts.backend.failAfterWrite = undefined
		const resumed = await dedupeMemory(opts)
		expect(resumed.audit.normalizedDuplicates).toBe(0)
		expect(opts.backend.rows).toHaveLength(3)
		expect(opts.backend.updateCalls).toBe(2)
		expect(opts.backend.writeCalls).toBe(4)

		await dedupeMemory(opts)
		expect(opts.backend.updateCalls).toBe(2)
		expect(opts.backend.writeCalls).toBe(4)
	})

	it("preserves history tables and rejects a bad snapshot before changing facts", async () => {
		const opts = options()
		writeFileSync(historyDbPath(opts.dbPath), "")
		const { checkpoint } = await dedupeMemory(opts)
		const manifest = JSON.parse(readFileSync(checkpoint, "utf-8")) as {
			files: Array<{ kind?: string; snapshot: string }>
		}
		const historyFile = manifest.files.find((file) => file.kind === "history")
		if (!historyFile) throw new Error("missing history snapshot")
		const raw = readFileSync(historyFile.snapshot, "utf-8")
		opts.backend.history = opts.backend.history.map((row) => ({ ...row, new_value: "tampered history" }))
		writeFileSync(
			historyFile.snapshot,
			JSON.stringify(JSON.parse(raw).map((table: { rows: unknown[] }) => ({ ...table, rows: [] }))),
		)
		await expect(rollbackMaintenance(checkpoint, opts.backend, opts)).rejects.toThrow("snapshot checksum mismatch")
		expect(opts.backend.rows).toHaveLength(4)

		writeFileSync(historyFile.snapshot, raw)
		await rollbackMaintenance(checkpoint, opts.backend, opts)
		expect(opts.backend.history).toHaveLength(1)
		expect(opts.backend.history[0]).toMatchObject({
			previous_value: "old preference",
			new_value: "new preference",
			raw: [1, 0, 0, 0],
		})
	})

	it("dedupes duplicates introduced again by a rollback", async () => {
		const opts = options()
		const { checkpoint } = await maintainMemory(opts)
		await dedupeMemory(opts)
		await rollbackMaintenance(checkpoint, opts.backend, opts)

		const reopened = options()
		const again = await dedupeMemory(reopened)
		expect(again.audit.normalizedDuplicates).toBe(0)
		expect(reopened.backend.rows).toHaveLength(4)
	})

	it("restores the snapshot on rollback, refuses unexpected changes, and releases its lock", async () => {
		const opts = options()
		const { checkpoint } = await maintainMemory(opts)
		await dedupeMemory(opts)
		await rollbackMaintenance(checkpoint, opts.backend, opts)
		expect(opts.backend.rows.map((row) => row.id).sort()).toEqual(
			["alpha-old", "alpha-copy", "first-fix", "second-fix", "distinct"].sort(),
		)
		expect(opts.backend.rows.find((row) => row.id === "alpha-old")?.metadata).toEqual(metadata)

		await dedupeMemory(opts)
		opts.backend.rows.push({ id: "unexpected", memory: "a different fact" })
		await expect(rollbackMaintenance(checkpoint, opts.backend, opts)).rejects.toThrow(
			"store changed unexpectedly after dedupe",
		)
		await opts.backend.delete("unexpected")
		await rollbackMaintenance(checkpoint, opts.backend, opts)
		expect(opts.backend.rows).toHaveLength(5)
	})
})
