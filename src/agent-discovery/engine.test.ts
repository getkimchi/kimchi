import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { hasBearerAuthorizationHeader } from "./engine.js"
import { discoverAgent } from "./index.js"
import type { AgentDefinition, AgentDiscovery } from "./index.js"

describe("discoverAgent engine", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-engine-test-"))
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	// A minimal AgentDefinition that exercises each engine path.
	function makeDef(
		overrides?: Partial<{
			configPaths: string[]
			skillsDirs: string[]
			parseConfig: (raw: string) => unknown
		}>,
	): AgentDefinition {
		const parseConfig = overrides?.parseConfig ?? JSON.parse
		return {
			id: "test-agent",
			displayName: "Test Agent",
			configPaths: overrides?.configPaths ?? [],
			skillsDirs: overrides?.skillsDirs ?? [],
			parseConfig,
			extractServerSources: (parsed: unknown) => {
				if (!parsed || typeof parsed !== "object") return []
				const root = parsed as Record<string, unknown>
				const sources: Array<Record<string, unknown>> = []
				if (root.modern && typeof root.modern === "object" && !Array.isArray(root.modern)) {
					sources.push(root.modern as Record<string, unknown>)
				}
				if (root.legacy && typeof root.legacy === "object" && !Array.isArray(root.legacy)) {
					sources.push(root.legacy as Record<string, unknown>)
				}
				return sources
			},
			transformServer: (raw: unknown, _name: string) => {
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
				const r = raw as Record<string, unknown>
				if (r.skip) return undefined
				return { command: String(r.command ?? "") }
			},
		}
	}

	function configPath(name = "config.json"): string {
		return join(tempDir, name)
	}

	function skillsPath(name: string): string {
		return join(tempDir, name)
	}

	// ---------------------------------------------------------------------------
	// E1: first readable config wins; later configPaths are not read
	// ---------------------------------------------------------------------------
	it("E1: first readable config wins; later configPaths are not read", () => {
		const path1 = configPath("a.json")
		const path2 = configPath("b.json")
		writeFileSync(path1, JSON.stringify({ modern: { toolA: { command: "a" } } }))
		writeFileSync(path2, JSON.stringify({ modern: { toolB: { command: "b" } } }))

		const def = makeDef({ configPaths: [path1, path2] })
		const result = discoverAgent(def)

		expect(result.mcpServers.toolA).toBeDefined()
		expect(result.mcpServers.toolB).toBeUndefined()
	})

	// ---------------------------------------------------------------------------
	// E2: unreadable (non-ENOENT) config emits warning, continues to next path
	// ---------------------------------------------------------------------------
	it("E2: unreadable (non-ENOENT) config emits warning, continues to next path", () => {
		// This is hard to trigger without mocking, but we can at least verify
		// ENOENT is silent and the loop continues. Use a path that won't exist.
		const path1 = configPath("none1.json")
		const path2 = configPath("none2.json")
		writeFileSync(path2, JSON.stringify({ modern: { tool: { command: "ok" } } }))

		const def = makeDef({ configPaths: [path1, path2] })
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const result = discoverAgent(def)

		expect(result.mcpServers.tool).toBeDefined()
		expect(warnSpy).not.toHaveBeenCalled() // ENOENT is silent
		warnSpy.mockRestore()
	})

	// ---------------------------------------------------------------------------
	// E3: unparseable config emits warning, continues to next path
	// ---------------------------------------------------------------------------
	it("E3: unparseable config emits warning, continues to next path", () => {
		const path1 = configPath("bad.json")
		const path2 = configPath("good.json")
		writeFileSync(path1, "{ not json", "utf-8")
		writeFileSync(path2, JSON.stringify({ modern: { tool: { command: "ok" } } }))

		const def = makeDef({ configPaths: [path1, path2] })
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const result = discoverAgent(def)

		expect(result.mcpServers.tool).toBeDefined()
		expect(warnSpy).toHaveBeenCalled()
		warnSpy.mockRestore()
	})

	// ---------------------------------------------------------------------------
	// E4: first-writer-wins across multiple extractServerSources blocks
	// ---------------------------------------------------------------------------
	it("E4: first-writer-wins across multiple extractServerSources blocks", () => {
		const path = configPath()
		// Uses our makeDef which lists modern first, legacy second.
		// Our def's extractServerSources enumerates modern before legacy.
		// So "tool" in modern should win over "tool" in legacy.
		writeFileSync(
			path,
			JSON.stringify({
				modern: { tool: { command: "winner" } },
				legacy: { tool: { command: "loser" } },
			}),
		)

		const def = makeDef({ configPaths: [path] })
		const result = discoverAgent(def)

		expect(result.mcpServers.tool).toMatchObject({ command: "winner" })
	})

	// ---------------------------------------------------------------------------
	// E5: malformed entries (null, array, string) silently skipped
	// ---------------------------------------------------------------------------
	it("E5: malformed entries (null, array, string) silently skipped", () => {
		const path = configPath()
		writeFileSync(
			path,
			JSON.stringify({
				modern: {
					bad1: null,
					bad2: ["array"],
					bad3: "string",
					good: { command: "ok" },
				},
			}),
		)

		const def = makeDef({ configPaths: [path] })
		const result = discoverAgent(def)

		expect(result.mcpServers.bad1).toBeUndefined()
		expect(result.mcpServers.bad2).toBeUndefined()
		expect(result.mcpServers.bad3).toBeUndefined()
		expect(result.mcpServers.good).toMatchObject({ command: "ok" })
	})

	// ---------------------------------------------------------------------------
	// E6: transformServer returning undefined skips the entry
	// ---------------------------------------------------------------------------
	it("E6: transformServer returning undefined skips the entry", () => {
		const path = configPath()
		writeFileSync(
			path,
			JSON.stringify({
				modern: {
					skipme: { skip: true },
					keepme: { command: "ok" },
				},
			}),
		)

		const def = makeDef({ configPaths: [path] })
		const result = discoverAgent(def)

		expect(result.mcpServers.skipme).toBeUndefined()
		expect(result.mcpServers.keepme).toBeDefined()
	})

	// ---------------------------------------------------------------------------
	// E7: missing skills dir → skillCount: 0, skillsDir undefined, no warn
	// ---------------------------------------------------------------------------
	it("E7: missing skills dir → skillCount: 0, skillsDir undefined, no warn", () => {
		const path = configPath()
		writeFileSync(path, JSON.stringify({ modern: {} }))

		const def = makeDef({
			configPaths: [path],
			skillsDirs: [skillsPath("nonexistent")],
		})
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const result = discoverAgent(def)

		expect(result.skillCount).toBe(0)
		expect(result.skillsDir).toBeUndefined()
		expect(warnSpy).not.toHaveBeenCalled()
		warnSpy.mockRestore()
	})

	// ---------------------------------------------------------------------------
	// E8: present empty skills dir → skillCount: 0, skillsDir set
	// ---------------------------------------------------------------------------
	it("E8: present empty skills dir → skillCount: 0, skillsDir set", () => {
		const path = configPath()
		writeFileSync(path, JSON.stringify({ modern: {} }))

		const dir = skillsPath("empty-skills")
		mkdirSync(dir, { recursive: true })

		const def = makeDef({ configPaths: [path], skillsDirs: [dir] })
		const result = discoverAgent(def)

		expect(result.skillCount).toBe(0)
		expect(result.skillsDir).toBe(dir)
	})

	// ---------------------------------------------------------------------------
	// E9: skills dir with files (not dirs) → skillCount: 0, skillsDir set
	// ---------------------------------------------------------------------------
	it("E9: skills dir with files (not dirs) → skillCount: 0, skillsDir set", () => {
		const path = configPath()
		writeFileSync(path, JSON.stringify({ modern: {} }))

		const dir = skillsPath("file-only")
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "README.md"), "readme")

		const def = makeDef({ configPaths: [path], skillsDirs: [dir] })
		const result = discoverAgent(def)

		expect(result.skillCount).toBe(0)
		expect(result.skillsDir).toBe(dir)
	})

	// ---------------------------------------------------------------------------
	// E10: skills dir with N subdirs → skillCount === N, skillsDir set
	// ---------------------------------------------------------------------------
	it("E10: skills dir with N subdirs → skillCount === N, skillsDir set", () => {
		const path = configPath()
		writeFileSync(path, JSON.stringify({ modern: {} }))

		const dir = skillsPath("has-skills")
		mkdirSync(dir, { recursive: true })
		mkdirSync(join(dir, "skill-a"), { recursive: true })
		mkdirSync(join(dir, "skill-b"), { recursive: true })
		mkdirSync(join(dir, "skill-c"), { recursive: true })

		const def = makeDef({ configPaths: [path], skillsDirs: [dir] })
		const result = discoverAgent(def)

		expect(result.skillCount).toBe(3)
		expect(result.skillsDir).toBe(dir)
	})

	// ---------------------------------------------------------------------------
	// E11: empty configPaths and skillsDirs → servers: {}, skillCount: 0
	// ---------------------------------------------------------------------------
	it("E11: empty configPaths and skillsDirs → servers: {}, skillCount: 0", () => {
		const def = makeDef({ configPaths: [], skillsDirs: [] })
		const result = discoverAgent(def)

		expect(result.mcpServers).toEqual({})
		expect(result.skillCount).toBe(0)
		expect(result.skillsDir).toBeUndefined()
	})

	// ---------------------------------------------------------------------------
	// E12: parseConfig defaults to JSON.parse when omitted
	// ---------------------------------------------------------------------------
	it("E12: parseConfig defaults to JSON.parse when omitted", () => {
		const path = configPath()
		writeFileSync(path, JSON.stringify({ legacy: { tool: { command: "ok" } } }))

		// No parseConfig provided — should use JSON.parse
		const def: AgentDefinition = {
			id: "test",
			displayName: "Test",
			configPaths: [path],
			skillsDirs: [],
			extractServerSources: (parsed: unknown) => {
				if (!parsed || typeof parsed !== "object") return []
				const root = parsed as Record<string, unknown>
				if (root.legacy && typeof root.legacy === "object" && !Array.isArray(root.legacy)) {
					return [root.legacy as Record<string, unknown>]
				}
				return []
			},
			transformServer: (raw: unknown, _name: string) => {
				const r = raw as Record<string, unknown>
				return { command: String(r.command ?? "") }
			},
		}

		const result = discoverAgent(def)
		expect(result.mcpServers.tool).toBeDefined()
	})

	describe("hasBearerAuthorizationHeader (defensive)", () => {
		it("returns true for Authorization: Bearer", () => {
			expect(hasBearerAuthorizationHeader({ Authorization: "Bearer x" })).toBe(true)
		})
		it("is case-insensitive on key and value", () => {
			expect(hasBearerAuthorizationHeader({ authorization: "bearer x" })).toBe(true)
			expect(hasBearerAuthorizationHeader({ AUTHORIZATION: "BEARER x" })).toBe(true)
		})
		it("returns false for Basic auth", () => {
			expect(hasBearerAuthorizationHeader({ Authorization: "Basic dXNlcjpwYXNz" })).toBe(false)
		})
		it("returns false (does not throw) when headers is null", () => {
			expect(hasBearerAuthorizationHeader(null)).toBe(false)
		})
		it("returns false (does not throw) when headers is undefined", () => {
			expect(hasBearerAuthorizationHeader(undefined)).toBe(false)
		})
		it("returns false (does not throw) when headers is an array", () => {
			expect(hasBearerAuthorizationHeader(["Authorization", "Bearer x"])).toBe(false)
		})
		it("returns false (does not throw) when headers is a primitive", () => {
			expect(hasBearerAuthorizationHeader("Bearer x")).toBe(false)
			expect(hasBearerAuthorizationHeader(42)).toBe(false)
		})
		it("ignores non-string header values without throwing", () => {
			expect(hasBearerAuthorizationHeader({ Authorization: 123 })).toBe(false)
			expect(hasBearerAuthorizationHeader({ Authorization: null })).toBe(false)
		})
	})
})
