/**
 * Bun-runtime acceptance check for the memory backend. Not a vitest file —
 * vitest runs on Node, where bun:sqlite (through shims/better-sqlite3)
 * cannot construct databases. Same split as src/integrations/cursor.ts.
 *
 * PART A: MemoryVectorStore hybrid surface — BM25 keyword search, cosine
 *         search, update, list, get, delete, persistence. Port of the
 *         spike's sqlite-shim-test.ts (see docs/memory-extension.md). No
 *         network.
 * PART B: full backend round-trip with real remote embeddings via the
 *         kimchi gateway (text-embedding-3-small) and add(infer: false),
 *         which exercises the store, the history manager, and the
 *         better-sqlite3 shim end to end.
 *
 * Usage: pnpm run memory:check  (requires KIMCHI_API_KEY or a configured
 * ~/.config/kimchi/config.json)
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMemoryBackend, disableMem0Telemetry } from "./backend.js"

// Before any mem0ai import — PART A imports it directly, and the flag is
// read once at mem0's module scope.
disableMem0Telemetry()

let failures = 0
const check = (label: string, cond: boolean, detail?: string): void => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
	if (!cond) failures++
}

async function partA(): Promise<void> {
	console.log("\n--- PART A: MemoryVectorStore (hybrid surface, no network) ---")
	const { MemoryVectorStore } = await import("mem0ai/oss")
	const dir = mkdtempSync(join(tmpdir(), "kimchi-memory-check-a-"))
	const dbPath = join(dir, "vector_store.db")
	try {
		const store = new MemoryVectorStore({ dimension: 4, dbPath })
		await store.insert(
			[
				[1, 0, 0, 0],
				[0, 1, 0, 0],
				[0.7, 0.7, 0, 0],
			],
			["m1", "m2", "m3"],
			[
				{ data: "user drinks regular coffee every morning", user_id: "u1" },
				{ data: "user works as a software engineer", user_id: "u1" },
				{ data: "user switched to decaf coffee last month", user_id: "u1" },
			],
		)
		check("insert 3 vectors", true)

		// BM25 keyword search — the method the langchain adapter stubs.
		const kw = await store.keywordSearch("coffee", 10)
		check(
			"keywordSearch (BM25) returns coffee docs, not the engineer doc",
			Array.isArray(kw) && kw.length > 0 && kw.every((r) => r.id !== "m2"),
			JSON.stringify(kw?.map((r) => ({ id: r.id, score: +(r.score ?? 0).toFixed(3) }))),
		)

		const sem = await store.search([1, 0, 0, 0], 2)
		check(
			"search (cosine) ranks m1 first",
			Array.isArray(sem) && sem.length === 2 && sem[0]?.id === "m1",
			JSON.stringify(sem?.map((r) => ({ id: r.id, score: +(r.score ?? 0).toFixed(3) }))),
		)

		await store.update("m3", [0, 0, 1, 0], { data: "user switched to decaf coffee last month", user_id: "u1" })
		const afterUpdate = await store.search([0, 0, 1, 0], 10)
		check(
			"update moves vector (real UPDATE)",
			afterUpdate.some((r) => r.id === "m3"),
		)

		const [, count] = await store.list()
		check("list returns count=3", count === 3, `count=${count}`)

		const got = await store.get("m1")
		check("get by id", !!got && got.payload.data.includes("coffee"))

		await store.delete("m2")
		const [, countAfter] = await store.list()
		check("delete removes row", countAfter === 2, `count=${countAfter}`)

		const reopened = new MemoryVectorStore({ dimension: 4, dbPath })
		const [, reopenedCount] = await reopened.list()
		check("persists to disk across instances", reopenedCount === 2, `count=${reopenedCount}`)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

async function partB(): Promise<void> {
	console.log("\n--- PART B: full backend round-trip (remote embeddings) ---")
	const dir = mkdtempSync(join(tmpdir(), "kimchi-memory-check-b-"))
	try {
		const memory = await createMemoryBackend({ dbPath: join(dir, "memory.db") })
		const userId = "check-user"

		const addT0 = Date.now()
		await memory.add(
			[
				{ role: "user", content: "I always use pnpm, never npm or yarn." },
				{ role: "assistant", content: "Noted: pnpm for package management." },
			],
			{ userId, infer: false },
		)
		console.log(`added in ${Date.now() - addT0}ms (infer: false — no extraction LLM call)`)

		const searchT0 = Date.now()
		const results = await memory.search("which package manager does the user prefer?", {
			filters: { user_id: userId },
		})
		console.log(`searched in ${Date.now() - searchT0}ms`)
		const list = (Array.isArray(results) ? results : (results?.results ?? [])) as Array<{
			memory?: string
			score?: number
		}>
		check(
			"search returns the added memory",
			list.some((r) => (r.memory ?? "").includes("pnpm")),
			JSON.stringify(list.map((r) => ({ memory: r.memory, score: r.score }))).slice(0, 300),
		)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

async function partC(): Promise<void> {
	console.log("\n--- PART C: storage concurrency (parallel writers + readers, one store) ---")
	const dir = mkdtempSync(join(tmpdir(), "kimchi-memory-check-c-"))
	try {
		const dbPath = join(dir, "memory.db")
		const backend = await createMemoryBackend({ dbPath })
		const userId = "check-user"
		// Writers and readers race on one store — WAL + busy_timeout must
		// absorb the contention (the lock failure mode from the investigation).
		const writers = Array.from({ length: 8 }, (_, i) =>
			backend.add(`concurrent fact ${i}: the user's favorite number is ${i * 7}`, { userId, infer: false }),
		)
		const readers = Array.from({ length: 8 }, () =>
			backend.search("favorite number", { filters: { user_id: userId }, topK: 5 }),
		)
		await Promise.all([...writers, ...readers])
		const all = await backend.search("concurrent fact", { filters: { user_id: userId }, topK: 10 })
		const list = (Array.isArray(all) ? all : (all?.results ?? [])) as Array<{ memory?: string }>
		check("parallel writes + concurrent reads complete without lock errors", list.length >= 8, `${list.length} facts`)
		check("history db lives next to the store (scope dir)", existsSync(join(dir, "memory-history.db")))
		check("no store files created relative to cwd", !existsSync(join(process.cwd(), "memory.db")))
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	await partA()
	await partB()
	await partC()
	console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
	process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err: unknown) => {
	console.error("memory check crashed:", err)
	process.exitCode = 1
})
