import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryBackend, memoryDbPath } from "./backend.js"
import { MEMORY_SCOPE_ID, MEMORY_USER_ID } from "./config.js"
import { agentMemoryMigrationMarkerPath, migrateAgentMemory } from "./migrate-agent-memory.js"

// createMemoryBackend requires the Bun runtime (mem0's SQLite store); the
// migration's contract with it is small enough to fake.
vi.mock("./backend.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./backend.js")>()
	return { ...actual, createMemoryBackend: vi.fn() }
})

const fakeBackend = { add: vi.fn(), getAll: vi.fn() }

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "agent-mem-home-"))
}

function agentDir(home: string, name: string): string {
	return join(home, ".config", "kimchi", "harness", "agent-memory", name)
}

function writeMemory(home: string, name: string, content: string): void {
	const dir = agentDir(home, name)
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, "MEMORY.md"), content)
}

describe("migrateAgentMemory", () => {
	let home: string
	let memoryDir: string

	beforeEach(() => {
		home = makeHome()
		memoryDir = mkdtempSync(join(tmpdir(), "agent-mem-store-"))
		vi.mocked(createMemoryBackend)
			.mockReset()
			.mockResolvedValue(fakeBackend as never)
		fakeBackend.add.mockReset()
		fakeBackend.getAll.mockReset().mockResolvedValue({ results: [] })
	})

	afterEach(() => {
		rmSync(home, { recursive: true, force: true })
		rmSync(memoryDir, { recursive: true, force: true })
	})

	it("no agent-memory directory: migrates nothing, writes the marker, no backend", async () => {
		expect(await migrateAgentMemory({ homeDir: home, memoryDir })).toBe(0)
		expect(createMemoryBackend).not.toHaveBeenCalled()
		expect(existsSync(agentMemoryMigrationMarkerPath(memoryDir))).toBe(true)
	})

	it("migrates each MEMORY.md into the personal store with provenance", async () => {
		writeMemory(home, "Research-Assistant", "- Vetted source: official docs")
		expect(await migrateAgentMemory({ homeDir: home, memoryDir })).toBe(1)
		expect(createMemoryBackend).toHaveBeenCalledWith({ dbPath: memoryDbPath(MEMORY_SCOPE_ID) })
		expect(fakeBackend.add).toHaveBeenCalledWith("Agent memory (Research-Assistant): - Vetted source: official docs", {
			userId: MEMORY_USER_ID,
			infer: false,
		})
		expect(existsSync(agentMemoryMigrationMarkerPath(memoryDir))).toBe(true)
	})

	it("marker present: no-op without touching the backend", async () => {
		writeFileSync(agentMemoryMigrationMarkerPath(memoryDir), "done")
		writeMemory(home, "Research-Assistant", "- would have migrated")
		expect(await migrateAgentMemory({ homeDir: home, memoryDir })).toBe(0)
		expect(createMemoryBackend).not.toHaveBeenCalled()
		expect(fakeBackend.add).not.toHaveBeenCalled()
	})

	it("skips symlinked MEMORY.md files", async () => {
		const dir = agentDir(home, "Evil")
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(home, "target.md"), "- outside")
		symlinkSync(join(home, "target.md"), join(dir, "MEMORY.md"))
		expect(await migrateAgentMemory({ homeDir: home, memoryDir })).toBe(0)
		expect(fakeBackend.add).not.toHaveBeenCalled()
	})

	it("truncates content beyond the legacy 200-line cap", async () => {
		writeMemory(home, "Test-Writer", Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n"))
		expect(await migrateAgentMemory({ homeDir: home, memoryDir })).toBe(1)
		const text = fakeBackend.add.mock.calls[0]?.[0] as string
		expect(text).toContain("line 200")
		expect(text).not.toContain("line 201")
		expect(text).toContain("... (truncated at 200 lines)")
	})

	it("skips empty files", async () => {
		writeMemory(home, "Empty", "   \n")
		expect(await migrateAgentMemory({ homeDir: home, memoryDir })).toBe(0)
		expect(fakeBackend.add).not.toHaveBeenCalled()
	})

	it("a retry after a partial failure does not re-add already-migrated content", async () => {
		writeMemory(home, "Research-Assistant", "- vetted sources")
		fakeBackend.getAll.mockResolvedValue({
			results: [{ memory: "Agent memory (Research-Assistant): - vetted sources" }],
		})
		expect(await migrateAgentMemory({ homeDir: home, memoryDir })).toBe(0)
		expect(fakeBackend.add).not.toHaveBeenCalled()
		expect(existsSync(agentMemoryMigrationMarkerPath(memoryDir))).toBe(true)
	})

	it("backend failure: no marker (retried next session), never throws", async () => {
		writeMemory(home, "Research-Assistant", "- vetted sources")
		vi.mocked(createMemoryBackend).mockRejectedValue(new Error("boom"))
		await expect(migrateAgentMemory({ homeDir: home, memoryDir })).resolves.toBe(0)
		expect(existsSync(agentMemoryMigrationMarkerPath(memoryDir))).toBe(false)
	})
})
