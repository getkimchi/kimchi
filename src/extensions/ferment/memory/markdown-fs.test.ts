import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MarkdownFsMemoryStore } from "./markdown-fs.js"
import type { MemoryEntry } from "./types.js"

describe("MarkdownFsMemoryStore", () => {
	let tmpDir: string
	let store: MarkdownFsMemoryStore

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "markdown-fs-test-"))
		store = new MarkdownFsMemoryStore({
			userRoot: join(tmpDir, "user"),
			projectRoot: join(tmpDir, "project"),
			localRoot: join(tmpDir, "local"),
		})
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	function makeEntry(
		partial: Partial<MemoryEntry> & { key: string; scope: "user" | "project" | "local" },
	): MemoryEntry {
		return {
			body: "default body",
			metadata: {
				schema_version: 1,
				scope: partial.scope,
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				tags: [],
			},
			...partial,
		}
	}

	describe("read", () => {
		it("returns null for missing key", async () => {
			const result = await store.read("project", "nonexistent")
			expect(result).toBeNull()
		})

		it("returns entry for existing key with correct body and metadata", async () => {
			const entry = makeEntry({
				key: "api-conventions",
				scope: "project",
				body: "# API Conventions\n\nUse kebab-case.",
				metadata: {
					schema_version: 1,
					scope: "project",
					created_at: "2024-01-01T00:00:00Z",
					updated_at: "2024-06-15T12:30:00Z",
					tags: ["convention", "api"],
				},
			})
			await store.write(entry)

			const result = await store.read("project", "api-conventions")
			expect(result).not.toBeNull()
			expect(result?.key).toBe("api-conventions")
			expect(result?.scope).toBe("project")
			expect(result?.body).toBe("# API Conventions\n\nUse kebab-case.")
			expect(result?.metadata.schema_version).toBe(1)
			expect(result?.metadata.tags).toEqual(["convention", "api"])
		})

		it("rejects path traversal keys", async () => {
			await expect(store.read("project", "../../../etc/passwd")).rejects.toThrow()
		})
	})

	describe("write", () => {
		it("creates <scopeRoot>/<scope>/<key>.md with YAML frontmatter + body", async () => {
			const entry = makeEntry({
				key: "hello",
				scope: "user",
				body: "Hello world",
				metadata: {
					schema_version: 1,
					scope: "user",
					created_at: "2024-01-01T00:00:00Z",
					updated_at: "2024-01-01T00:00:00Z",
					tags: ["greeting"],
				},
			})
			await store.write(entry)

			const filePath = join(tmpDir, "user", "hello.md")
			expect(existsSync(filePath)).toBe(true)

			const content = readFileSync(filePath, "utf-8")
			expect(content).toContain("---")
			expect(content).toContain("schema_version: 1")
			expect(content).toContain('scope: "user"')
			expect(content).toContain("tags:")
			expect(content).toContain("Hello world")
		})

		it("overwrites existing file", async () => {
			const initial = makeEntry({
				key: "overwrite",
				scope: "project",
				body: "first",
			})
			const updated = makeEntry({
				key: "overwrite",
				scope: "project",
				body: "second",
				metadata: {
					schema_version: 1,
					scope: "project",
					created_at: "2024-01-01T00:00:00Z",
					updated_at: "2024-06-15T12:30:00Z",
					tags: [],
				},
			})

			await store.write(initial)
			await store.write(updated)

			const result = await store.read("project", "overwrite")
			expect(result?.body).toBe("second")
		})
	})

	describe("list", () => {
		it("returns all entries for scope", async () => {
			await store.write(makeEntry({ key: "a", scope: "project", body: "A" }))
			await store.write(makeEntry({ key: "b", scope: "project", body: "B" }))
			await store.write(makeEntry({ key: "c", scope: "user", body: "C" }))

			const results = await store.list("project")
			expect(results).toHaveLength(2)
			const keys = results.map((r) => r.key).sort()
			expect(keys).toEqual(["a", "b"])
		})

		it("filters by agent", async () => {
			await store.write(
				makeEntry({
					key: "agent-a",
					scope: "project",
					body: "A",
					metadata: {
						schema_version: 1,
						scope: "project",
						created_at: "2024-01-01T00:00:00Z",
						updated_at: "2024-01-01T00:00:00Z",
						tags: [],
						agent: "planner",
					},
				}),
			)
			await store.write(
				makeEntry({
					key: "agent-b",
					scope: "project",
					body: "B",
					metadata: {
						schema_version: 1,
						scope: "project",
						created_at: "2024-01-01T00:00:00Z",
						updated_at: "2024-01-01T00:00:00Z",
						tags: [],
						agent: "coder",
					},
				}),
			)

			const results = await store.list("project", { agent: "planner" })
			expect(results).toHaveLength(1)
			expect(results[0]?.key).toBe("agent-a")
		})

		it("filters by ferment_id", async () => {
			await store.write(
				makeEntry({
					key: "ferm-1",
					scope: "local",
					body: "X",
					metadata: {
						schema_version: 1,
						scope: "local",
						created_at: "2024-01-01T00:00:00Z",
						updated_at: "2024-01-01T00:00:00Z",
						tags: [],
						ferment_id: "abc123",
					},
				}),
			)
			await store.write(
				makeEntry({
					key: "ferm-2",
					scope: "local",
					body: "Y",
					metadata: {
						schema_version: 1,
						scope: "local",
						created_at: "2024-01-01T00:00:00Z",
						updated_at: "2024-01-01T00:00:00Z",
						tags: [],
						ferment_id: "def456",
					},
				}),
			)

			const results = await store.list("local", { ferment_id: "abc123" })
			expect(results).toHaveLength(1)
			expect(results[0]?.key).toBe("ferm-1")
		})

		it("returns empty array when none match", async () => {
			const results = await store.list("user")
			expect(results).toEqual([])
		})
	})

	describe("delete", () => {
		it("removes the file", async () => {
			const entry = makeEntry({ key: "to-delete", scope: "project", body: "bye" })
			await store.write(entry)
			expect(existsSync(join(tmpDir, "project", "to-delete.md"))).toBe(true)

			await store.delete("project", "to-delete")
			expect(existsSync(join(tmpDir, "project", "to-delete.md"))).toBe(false)
		})

		it("no-throw for unknown key", async () => {
			await expect(store.delete("project", "unknown")).resolves.toBeUndefined()
		})
	})

	describe("atomic write", () => {
		it("cleans up .tmp file on failure and leaves original untouched", async () => {
			const scopeDir = join(tmpDir, "project")
			mkdirSync(scopeDir, { recursive: true })

			const initial = makeEntry({ key: "atomic", scope: "project", body: "original" })
			await store.write(initial)

			// Make directory read-only so a second write fails.
			chmodSync(scopeDir, 0o555)

			const updated = makeEntry({ key: "atomic", scope: "project", body: "updated" })
			await expect(store.write(updated)).rejects.toThrow()

			// Restore permissions for cleanup.
			chmodSync(scopeDir, 0o755)

			// Original must still be intact.
			const result = await store.read("project", "atomic")
			expect(result?.body).toBe("original")

			// No stale .tmp file should remain.
			const files = readdirSync(scopeDir)
			expect(files.some((f) => f.endsWith(".tmp"))).toBe(false)
		})
	})

	describe("path traversal security", () => {
		it("read with ../../../etc/passwd throws", async () => {
			await expect(store.read("project", "../../../etc/passwd")).rejects.toThrow()
		})
	})
})
