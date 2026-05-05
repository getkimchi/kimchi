import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MemoryStore } from "./memory-store.js"

describe("MemoryStore", () => {
	let tmpDir: string
	let store: MemoryStore

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-memory-test-"))
		store = new MemoryStore({
			memoryDir: tmpDir,
			memoryCharLimit: 100,
			userCharLimit: 80,
		})
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("adds an entry to memory", async () => {
		const result = await store.add("memory", "First note.")
		expect(result.success).toBe(true)
		expect(result.entry_count).toBe(1)
	})

	it("rejects duplicate entries", async () => {
		await store.add("memory", "Dup.")
		const result = await store.add("memory", "Dup.")
		expect(result.success).toBe(true)
		expect(result.message).toContain("already exists")
		expect(result.entry_count).toBe(1)
	})

	it("rejects entries that exceed char limit", async () => {
		const result = await store.add("memory", "x".repeat(101))
		expect(result.success).toBe(false)
		expect(result.error).toContain("exceed the limit")
	})

	it("replaces an entry by substring match", async () => {
		await store.add("memory", "Old text here.")
		const result = await store.replace("memory", "Old text", "New text here.")
		expect(result.success).toBe(true)
		expect(result.entries).toEqual(["New text here."])
	})

	it("remove by substring match", async () => {
		await store.add("memory", "Remove me.")
		const result = await store.remove("memory", "Remove me")
		expect(result.success).toBe(true)
		expect(result.entry_count).toBe(0)
	})

	it("returns frozen snapshot", async () => {
		await store.add("memory", "Frozen.")
		await store.loadFromDisk()
		const snapshot = store.formatForSystemPrompt("memory")
		expect(snapshot).toContain("Frozen.")
		await store.add("memory", "Live.")
		const stillSnapshot = store.formatForSystemPrompt("memory")
		expect(stillSnapshot).toContain("Frozen.")
		expect(stillSnapshot).not.toContain("Live.")
	})
})
