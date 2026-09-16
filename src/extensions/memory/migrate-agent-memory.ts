/**
 * One-time migration from the legacy agent-memory system into the personal
 * memory store.
 *
 * The legacy system (removed when this extension replaced it) gave subagents
 * per-agent MEMORY.md files under ~/.config/kimchi/harness/agent-memory/
 * <name>/, injected into their system prompts. Users who built up content
 * there get it carried into the new store instead of silently dropping it.
 * Only the user scope is migrated — it was the only scope that followed the
 * user; project-scoped agent memory (.kimchi/agent-memory/) stays in its
 * repo, untouched.
 *
 * Runs at most once per machine: a marker file in the memory root guards
 * re-runs, and a retry after a partial failure is idempotent (already-
 * migrated content is detected and skipped). Never throws — a failed
 * migration degrades to no migration, per the extension's cardinal rule
 * that memory must never break a session.
 */
import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createMemoryBackend, defaultMemoryDir, memoryDbPath } from "./backend.js"
import { MEMORY_SCOPE_ID, MEMORY_USER_ID } from "./config.js"

/** Written into the memory root after a completed migration (or a confirmed-empty one). */
const MIGRATION_MARKER = ".agent-memory-migrated"

/** Parity with the legacy reader's cap on MEMORY.md. */
const MAX_MIGRATED_LINES = 200

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink()
	} catch {
		return false
	}
}

/** Read a MEMORY.md with the legacy reader's guards (missing, symlinked, unreadable → undefined). */
function readAgentMemoryFile(path: string): string | undefined {
	if (!existsSync(path) || isSymlink(path)) return undefined
	try {
		return readFileSync(path, "utf-8")
	} catch {
		return undefined
	}
}

export function agentMemoryMigrationMarkerPath(memoryDir = defaultMemoryDir()): string {
	return join(memoryDir, MIGRATION_MARKER)
}

/**
 * The user-scope agent MEMORY.md files that exist on this machine, capped
 * at the legacy 200-line read. Pure — no backend construction; exported for
 * tests.
 */
export function collectAgentMemoryFiles(homeDir = homedir()): Array<{ agentName: string; content: string }> {
	const root = join(homeDir, ".config", "kimchi", "harness", "agent-memory")
	if (!existsSync(root) || isSymlink(root)) return []
	let entries: Dirent[]
	try {
		entries = readdirSync(root, { withFileTypes: true })
	} catch {
		return []
	}
	const out: Array<{ agentName: string; content: string }> = []
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue
		const content = readAgentMemoryFile(join(root, entry.name, "MEMORY.md"))
		if (content === undefined) continue
		const lines = content.split("\n")
		const text =
			lines.length > MAX_MIGRATED_LINES
				? `${lines.slice(0, MAX_MIGRATED_LINES).join("\n")}\n... (truncated at ${MAX_MIGRATED_LINES} lines)`
				: content
		if (text.trim().length === 0) continue
		out.push({ agentName: entry.name, content: text })
	}
	return out
}

/**
 * Run the one-time migration. Returns the number of MEMORY.md files
 * migrated. Never throws; on failure the marker is not written, so a
 * transient failure is retried on the next session start.
 */
export async function migrateAgentMemory(options: { homeDir?: string; memoryDir?: string } = {}): Promise<number> {
	const homeDir = options.homeDir ?? homedir()
	const memoryDir = options.memoryDir ?? defaultMemoryDir()
	if (existsSync(agentMemoryMigrationMarkerPath(memoryDir))) return 0
	try {
		const files = collectAgentMemoryFiles(homeDir)
		if (files.length === 0) {
			writeMarker(memoryDir)
			return 0
		}
		const backend = await createMemoryBackend({ dbPath: memoryDbPath(MEMORY_SCOPE_ID) })
		// Idempotency: a retry after a partial failure must not re-add content
		// that already landed (infer:false adds are raw — the store does not
		// dedupe them itself).
		const existing = new Set<string>()
		try {
			const all = (await backend.getAll({ filters: { user_id: MEMORY_USER_ID }, topK: 100_000 })) as unknown as {
				results?: Array<{ memory?: string }>
			}
			for (const item of all?.results ?? []) {
				if (typeof item?.memory === "string") existing.add(item.memory)
			}
		} catch {
			// Unknown existing set — proceed without dedupe; the failure window
			// duplicates could appear in is a partial add crash, which is rare.
		}
		let migrated = 0
		for (const { agentName, content } of files) {
			// infer: false — the content is imported as-is; re-extracting agent
			// notes through the conversation-shaped extraction prompts would
			// misframe them. The prefix records where the content came from.
			const text = `Agent memory (${agentName}): ${content}`
			if (existing.has(text)) continue
			await backend.add(text, { userId: MEMORY_USER_ID, infer: false })
			migrated += 1
		}
		writeMarker(memoryDir)
		return migrated
	} catch (err) {
		console.error("[memory] agent-memory migration failed:", err instanceof Error ? err.message : err)
		return 0
	}
}

function writeMarker(memoryDir: string): void {
	try {
		writeFileSync(join(memoryDir, MIGRATION_MARKER), new Date().toISOString())
	} catch {
		// Unwritable marker — the migration may re-run next session; the
		// dedupe check keeps that harmless.
	}
}
