import { describe, expect, it } from "vitest"

import { type MemoryEntry, type MemoryFrontmatter, type MemoryStore, memoryFrontmatterSchema } from "./types.js"

describe("memoryFrontmatterSchema", () => {
	it("parses valid frontmatter", () => {
		const result = memoryFrontmatterSchema.safeParse({
			schema_version: 1,
			scope: "project",
			agent: "planner",
			ferment_id: "abc123",
			created_at: "2024-01-01T00:00:00Z",
			updated_at: "2024-06-15T12:30:00Z",
			tags: ["convention", "api"],
		})
		expect(result.success).toBe(true)
	})

	it("requires schema_version to be literal 1", () => {
		const result = memoryFrontmatterSchema.safeParse({
			schema_version: 2,
			scope: "project",
			created_at: "2024-01-01T00:00:00Z",
			updated_at: "2024-01-01T00:00:00Z",
		})
		expect(result.success).toBe(false)
	})

	it("requires schema_version field", () => {
		const result = memoryFrontmatterSchema.safeParse({
			scope: "project",
			created_at: "2024-01-01T00:00:00Z",
			updated_at: "2024-01-01T00:00:00Z",
		})
		expect(result.success).toBe(false)
	})

	it("rejects invalid scope values", () => {
		const result = memoryFrontmatterSchema.safeParse({
			schema_version: 1,
			scope: "global",
			created_at: "2024-01-01T00:00:00Z",
			updated_at: "2024-01-01T00:00:00Z",
		})
		expect(result.success).toBe(false)
	})

	it("accepts all valid scope enum values", () => {
		for (const scope of ["user", "project", "local"] as const) {
			const result = memoryFrontmatterSchema.safeParse({
				schema_version: 1,
				scope,
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
			})
			expect(result.success).toBe(true)
		}
	})

	it("rejects non-datetime strings for created_at/updated_at", () => {
		const result = memoryFrontmatterSchema.safeParse({
			schema_version: 1,
			scope: "project",
			created_at: "not-a-date",
			updated_at: "2024-01-01T00:00:00Z",
		})
		expect(result.success).toBe(false)
	})

	it("defaults tags to empty array when omitted", () => {
		const result = memoryFrontmatterSchema.safeParse({
			schema_version: 1,
			scope: "user",
			created_at: "2024-01-01T00:00:00Z",
			updated_at: "2024-01-01T00:00:00Z",
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.tags).toEqual([])
		}
	})

	it("allows optional agent and ferment_id", () => {
		const result = memoryFrontmatterSchema.safeParse({
			schema_version: 1,
			scope: "local",
			created_at: "2024-01-01T00:00:00Z",
			updated_at: "2024-01-01T00:00:00Z",
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.agent).toBeUndefined()
			expect(result.data.ferment_id).toBeUndefined()
		}
	})
})

describe("MemoryEntry", () => {
	it("has required fields", () => {
		const metadata: MemoryFrontmatter = {
			schema_version: 1,
			scope: "project",
			created_at: "2024-01-01T00:00:00Z",
			updated_at: "2024-01-01T00:00:00Z",
			tags: ["api"],
		}
		const entry: MemoryEntry = {
			key: "api-conventions",
			scope: "project",
			body: "# API Conventions\n\nUse kebab-case.",
			metadata,
		}
		expect(entry.key).toBe("api-conventions")
		expect(entry.scope).toBe("project")
		expect(entry.body).toContain("kebab-case")
		expect(entry.metadata.schema_version).toBe(1)
	})
})

describe("MemoryStore interface", () => {
	const fakeStore: MemoryStore = {
		read: async (_scope: "user" | "project" | "local", key: string) => {
			if (key === "known") {
				return {
					key: "known",
					scope: "project",
					body: "Known body",
					metadata: {
						schema_version: 1,
						scope: "project",
						created_at: "2024-01-01T00:00:00Z",
						updated_at: "2024-01-01T00:00:00Z",
						tags: [],
					},
				}
			}
			return null
		},
		write: async (_entry: MemoryEntry) => {
			// no-op
		},
		list: async (_scope: "user" | "project" | "local", _opts?) => [
			{
				key: "entry-1",
				scope: "user",
				body: "User memory",
				metadata: {
					schema_version: 1,
					scope: "user",
					created_at: "2024-01-01T00:00:00Z",
					updated_at: "2024-01-01T00:00:00Z",
					tags: [],
				},
			},
		],
		delete: async (_scope: "user" | "project" | "local", _key: string) => {
			// no-op
		},
	}

	it("read returns an Entry for known key", async () => {
		const result = await fakeStore.read("project", "known")
		expect(result).not.toBeNull()
		expect(result?.key).toBe("known")
	})

	it("read returns null for unknown key", async () => {
		const result = await fakeStore.read("project", "missing")
		expect(result).toBeNull()
	})

	it("write returns void", async () => {
		const entry: MemoryEntry = {
			key: "new",
			scope: "local",
			body: "New body",
			metadata: {
				schema_version: 1,
				scope: "local",
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				tags: [],
			},
		}
		const result = await fakeStore.write(entry)
		expect(result).toBeUndefined()
	})

	it("list returns Entry array", async () => {
		const results = await fakeStore.list("user")
		expect(Array.isArray(results)).toBe(true)
		expect(results).toHaveLength(1)
		expect(results[0].key).toBe("entry-1")
	})

	it("delete returns void", async () => {
		const result = await fakeStore.delete("user", "entry-1")
		expect(result).toBeUndefined()
	})
})
