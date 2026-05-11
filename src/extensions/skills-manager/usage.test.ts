import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { UsageTracker } from "./usage.js"

describe("UsageTracker", () => {
	let tmpDir: string
	let tracker: UsageTracker

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-usage-test-"))
		tracker = new UsageTracker(tmpDir)
	})

	describe("bumpCreate", () => {
		it("creates .usage.json on first call", async () => {
			const entry = await tracker.bumpCreate("my-skill", true)
			expect(entry.name).toBe("my-skill")
			expect(entry.agent_created).toBe(true)
			expect(entry.state).toBe("active")
			expect(entry.patch_count).toBe(0)
			expect(entry.pinned).toBe(false)
			expect(entry.use_count).toBe(0)
			expect(entry.created_at).toBeDefined()
		})

		it("overwrites existing entry with fresh state", async () => {
			await tracker.bumpCreate("existing")
			const entry = await tracker.bumpCreate("existing")
			expect(entry.name).toBe("existing")
			expect(entry.patch_count).toBe(0)
		})
	})

	describe("bumpPatch", () => {
		it("increments patch_count after create", async () => {
			await tracker.bumpCreate("my-skill")
			const entry = await tracker.bumpPatch("my-skill")
			expect(entry.patch_count).toBe(1)
			expect(entry.last_patched_at).toBeDefined()
		})

		it("fails for non-existent skill", async () => {
			await expect(tracker.bumpPatch("nonexistent")).rejects.toThrow()
		})
	})

	describe("setPin", () => {
		it("sets pinned to true", async () => {
			await tracker.bumpCreate("my-skill")
			const entry = await tracker.setPin("my-skill", true)
			expect(entry.pinned).toBe(true)
		})

		it("sets pinned to false", async () => {
			await tracker.bumpCreate("my-skill")
			await tracker.setPin("my-skill", true)
			const entry = await tracker.setPin("my-skill", false)
			expect(entry.pinned).toBe(false)
		})

		it("fails for non-existent skill", async () => {
			await expect(tracker.setPin("nonexistent", true)).rejects.toThrow()
		})
	})

	describe("archive", () => {
		it("sets state to archived", async () => {
			await tracker.bumpCreate("my-skill")
			const entry = await tracker.archive("my-skill")
			expect(entry.state).toBe("archived")
		})

		it("sets absorbed_into when provided", async () => {
			await tracker.bumpCreate("my-skill")
			const entry = await tracker.archive("my-skill", "better")
			expect(entry.state).toBe("archived")
			expect(entry.absorbed_into).toBe("better")
		})

		it("fails for non-existent skill", async () => {
			await expect(tracker.archive("nonexistent")).rejects.toThrow()
		})
	})

	describe("get", () => {
		it("returns entry after create", async () => {
			await tracker.bumpCreate("my-skill")
			const entry = await tracker.get("my-skill")
			expect(entry).toBeDefined()
			expect(entry?.name).toBe("my-skill")
		})

		it("returns undefined for non-existent skill", async () => {
			const entry = await tracker.get("nonexistent")
			expect(entry).toBeUndefined()
		})
	})

	describe("concurrent operations", () => {
		it("two parallel bumpCreate calls on different skills both succeed", async () => {
			const tracker1 = new UsageTracker(tmpDir)
			const tracker2 = new UsageTracker(tmpDir)

			const [entry1, entry2] = await Promise.all([tracker1.bumpCreate("skill-a"), tracker2.bumpCreate("skill-b")])

			expect(entry1.name).toBe("skill-a")
			expect(entry2.name).toBe("skill-b")

			// Both should be persisted
			const tracker3 = new UsageTracker(tmpDir)
			const fetched1 = await tracker3.get("skill-a")
			const fetched2 = await tracker3.get("skill-b")
			expect(fetched1).toBeDefined()
			expect(fetched2).toBeDefined()
		})
	})
})
