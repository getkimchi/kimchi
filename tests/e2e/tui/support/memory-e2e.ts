import { execFileSync } from "node:child_process"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Seed the isolated home's personal memory store for TUI E2E tests. The
 * rows land in the same MemoryVectorStore the Memory class reads (verified:
 * admin list, the panel, and deletes all operate on them), so tests get a
 * deterministic store with no network and no capture pipeline.
 *
 * The seeding itself runs under bun (memory-seed.ts) — the vitest process
 * cannot construct the SQLite store on Node.
 */
export interface SeedMemoryFact {
	id: string
	text: string
}

// The runner compiles tests into .tui-test/cache, so import.meta.url points
// into the cache at run time — resolve the script through the repo root the
// runner exports (same derivation as kimchi-fixture.ts).
const REPO_ROOT = process.env.KIMCHI_REPO_ROOT
	? resolve(process.env.KIMCHI_REPO_ROOT)
	: fileURLToPath(new URL("../../../..", import.meta.url))
const SEED_SCRIPT = join(REPO_ROOT, "tests", "e2e", "tui", "support", "memory-seed.ts")

export function seedMemoryHome(homeDir: string, facts: SeedMemoryFact[]): void {
	const dbPath = join(homeDir, ".config", "kimchi", "memory", "personal", "memory.db")
	execFileSync("bun", [SEED_SCRIPT, dbPath, JSON.stringify(facts)], { cwd: REPO_ROOT, stdio: "pipe" })
}
