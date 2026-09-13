/**
 * Memory-store seeding helper for TUI E2E tests. Writes facts directly into
 * a MemoryVectorStore — the store the Memory class reads — with hand-made
 * unit vectors: no network, no capture pipeline, instant and deterministic.
 *
 * Run with the Bun runtime (the better-sqlite3 shim requires it); spawned
 * by the E2E test process, which cannot construct SQLite stores on Node:
 *
 *   bun tests/e2e/tui/support/memory-seed.ts <dbPath> <facts-json>
 *
 * where facts-json is `[{"id": "...", "text": "..."}, ...]`.
 */
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { MemoryVectorStore } from "mem0ai/oss"
import { MEMORY_EMBEDDING_DIMS } from "../../../../src/extensions/memory/backend.js"

interface SeedFact {
	id: string
	text: string
}

/** Unit vector with a 1 in position n — deterministic, distinct per fact. */
function unitVector(n: number): number[] {
	return Array.from({ length: MEMORY_EMBEDDING_DIMS }, (_, i) => (i === n ? 1 : 0))
}

if (import.meta.main) {
	const dbPath = process.argv[2]
	const facts = JSON.parse(process.argv[3] ?? "[]") as SeedFact[]
	if (!dbPath || facts.length === 0) {
		console.error("usage: memory-seed.ts <dbPath> <facts-json>")
		process.exit(1)
	}
	mkdirSync(dirname(dbPath), { recursive: true })
	const store = new MemoryVectorStore({ dimension: MEMORY_EMBEDDING_DIMS, dbPath })
	await store.insert(
		facts.map((_, i) => unitVector(i)),
		facts.map((f) => f.id),
		facts.map((f) => ({ data: f.text, user_id: "personal" })),
	)
	console.log(`seeded ${facts.length} fact(s) into ${dbPath}`)
}
