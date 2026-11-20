/** Bun acceptance: actual SQLite snapshot -> exact-dedupe -> rollback -> guarded restore.
 * Runs without gateway credentials; no extraction or embedding calls.
 * eslint/typescript build advice from the root contract is verified separately.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "better-sqlite3"
import { MemoryVectorStore } from "mem0ai/oss"
import { historyDbPath } from "./backend.js"
import { MEMORY_USER_ID } from "./config.js"
import { auditMemory, dedupeMemory, maintainMemory, rollbackMaintenance } from "./maintenance.js"

const vector = [1, 0, 0, 0]

type StoreEntry = {
	id: string
	payload: Record<string, unknown>
	score?: number
}

function memoryText(entry: StoreEntry): string {
	if (typeof entry.payload.data !== "string") throw new Error("invalid memory payload")
	return entry.payload.data
}

function backend(store: MemoryVectorStore) {
	return {
		async getAll() {
			const [records] = await store.list()
			return {
				results: records.map((entry: StoreEntry) => ({
					id: entry.id,
					memory: memoryText(entry),
					metadata: entry.payload.metadata,
				})),
			}
		},
		async add(text: string) {
			await store.insert([vector], [`new-${Date.now()}-${Math.random()}`], [{ data: text, user_id: MEMORY_USER_ID }])
		},
		async delete(id: string) {
			await store.delete(id)
		},
		async search() {
			const records = await store.search(vector, 20)
			return {
				results: records.map((entry: StoreEntry) => ({
					id: entry.id,
					memory: memoryText(entry),
					score: entry.score,
					metadata: entry.payload.metadata,
				})),
			}
		},
		async update(id: string, options: { metadata?: Record<string, unknown> }) {
			const found = await store.get(id)
			if (!found) throw new Error("missing fact")
			await store.update(id, vector, { ...found.payload, metadata: options.metadata })
		},
	}
}

async function main() {
	const root = mkdtempSync(join(tmpdir(), "kimchi-maintenance-check-"))
	const dbPath = join(root, "memory.db")
	const historyPath = historyDbPath(dbPath)
	const historyDb = new Database(historyPath)
	historyDb.exec(`
		CREATE TABLE IF NOT EXISTS memory_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			memory_id TEXT NOT NULL,
			previous_value TEXT,
			new_value TEXT,
			action TEXT NOT NULL,
			created_at TEXT,
			updated_at TEXT,
			is_deleted INTEGER DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS messages (
			id TEXT PRIMARY KEY,
			session_scope TEXT,
			role TEXT,
			content TEXT,
			name TEXT,
			created_at TEXT
		)
	`)
	historyDb
		.prepare(
			"INSERT INTO memory_history (memory_id, previous_value, new_value, action, created_at, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.run("alpha-old", "old preference", "new preference", "UPDATE", null, null, 0)
	historyDb
		.prepare("INSERT INTO messages (id, session_scope, role, content, name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.run("message-1", "kimchi", "user", "Review conventions", null, null)
	historyDb.close()
	const store = new MemoryVectorStore({ dimension: 4, dbPath })
	try {
		await store.insert([vector], ["alpha-old"], [{ data: "alpha old", user_id: MEMORY_USER_ID }])
		await store.insert([vector], ["alpha-copy"], [{ data: "alpha old", user_id: MEMORY_USER_ID }])
		await store.insert([vector], ["distinct"], [{ data: "distinct", user_id: MEMORY_USER_ID }])
		const current = backend(store)
		assert.equal((await auditMemory(current)).normalizedDuplicates, 1)
		const { checkpoint } = await maintainMemory({ dbPath, backend: current, memoryRoot: root })
		const first = await dedupeMemory({ dbPath, backend: current, memoryRoot: root })
		assert.equal(first.audit.normalizedDuplicates, 0)

		const after = new MemoryVectorStore({ dimension: 4, dbPath: join(root, "memory.db") })
		const afterBackend = backend(after)
		assert.equal((await auditMemory(afterBackend)).normalizedDuplicates, 0)
		const manifest = JSON.parse(readFileSync(checkpoint, "utf-8")) as {
			files: Array<{ kind?: string; snapshot: string }>
		}
		const historyFile = manifest.files.find((file) => file.kind === "history")
		assert.ok(historyFile, "history snapshot must be exported")
		const historyExport = readFileSync(historyFile.snapshot, "utf-8")

		await rollbackMaintenance(checkpoint, afterBackend)
		const builder = new MemoryVectorStore({ dimension: 4, dbPath: join(root, "memory.db") })
		const backendAfterRollback = backend(builder)
		const history = new Database(historyPath)
		history.prepare("UPDATE memory_history SET new_value = ?").run("tampered history")
		history.prepare("DELETE FROM messages").run()
		history.close()
		// Re-validate dedupe but corrupt the history artifact before any restore.
		await dedupeMemory({ dbPath, backend: backendAfterRollback, memoryRoot: root })
		writeFileSync(
			historyFile.snapshot,
			JSON.stringify(JSON.parse(historyExport).map((table: { rows: unknown[] }) => ({ ...table, rows: [] }))),
		)
		await assert.rejects(rollbackMaintenance(checkpoint, backendAfterRollback), /snapshot checksum mismatch/)
		assert.equal((await auditMemory(backendAfterRollback)).normalizedDuplicates, 0)
		const unreadHistory = new Database(historyPath)
		assert.equal((unreadHistory.prepare("SELECT count(*) AS count FROM messages").get() as { count: number }).count, 0)
		unreadHistory.close()
		writeFileSync(historyFile.snapshot, historyExport)
		await rollbackMaintenance(checkpoint, backendAfterRollback)
		const reopened = new MemoryVectorStore({ dimension: 4, dbPath: join(root, "memory.db") })
		const reopenedBackend = backend(reopened)
		assert.equal((await auditMemory(reopenedBackend)).normalizedDuplicates, 1)
		const recalled = await reopened.search(vector, 5)
		assert.ok(
			recalled.some((entry) => entry.id === "alpha-old"),
			"restored vectors must remain queryable",
		)
		assert.equal(Number(recalled.find((entry) => entry.id === "alpha-old")?.score), 1)

		const restored = new Database(historyPath)
		const record = restored.prepare("SELECT previous_value, new_value FROM memory_history").get() as {
			previous_value: string
			new_value: string
		}
		assert.deepEqual(record, { previous_value: "old preference", new_value: "new preference" })
		assert.equal((restored.prepare("SELECT count(*) AS count FROM memory_history").get() as { count: number }).count, 1)
		assert.equal((restored.prepare("SELECT count(*) AS count FROM messages").get() as { count: number }).count, 1)
		restored.close()

		await reopenedBackend.update("alpha-old", { metadata: { canonical: true } })
		await assert.rejects(rollbackMaintenance(checkpoint, reopenedBackend), /store changed unexpectedly after dedupe/)
		console.log("PASS Bun SQLite vector/history export, rollback, checksum preflight, and strict post-dedupe safety")
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
