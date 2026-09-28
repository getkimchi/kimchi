import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { projectDbPath } from "./backend.js"
import { digestDbPath } from "./config.js"
import type { SharedEmbedder } from "./embedder.js"
import { createScopedSearcher, mergeScopedResults, type ScopedBackend } from "./scoped-searcher.js"

describe("mergeScopedResults", () => {
	it("merges by score descending across stores", () => {
		const personal = [{ memory: "p1", score: 0.5, scope: "personal" as const }]
		const project = [
			{ memory: "pr1", score: 0.7, scope: "project" as const },
			{ memory: "pr2", score: 0.3, scope: "project" as const },
		]
		const merged = mergeScopedResults(personal, project, 8)
		expect(merged.map((m) => m.memory)).toEqual(["pr1", "p1", "pr2"])
	})

	it("trims to topK keeping the highest scores regardless of store", () => {
		const personal = Array.from({ length: 5 }, (_, i) => ({
			memory: `p${i}`,
			score: 0.5 - i * 0.01,
			scope: "personal" as const,
		}))
		const project = Array.from({ length: 5 }, (_, i) => ({
			memory: `q${i}`,
			score: 0.4 - i * 0.01,
			scope: "project" as const,
		}))
		const merged = mergeScopedResults(personal, project, 3)
		expect(merged).toHaveLength(3)
		expect(merged.map((m) => m.memory)).toEqual(["p0", "p1", "p2"])
	})

	it("handles empty stores on either side", () => {
		expect(mergeScopedResults([], [], 8)).toEqual([])
		expect(mergeScopedResults([{ memory: "only", score: 0.5, scope: "personal" }], [], 8)).toHaveLength(1)
	})
})

describe("createScopedSearcher wiring", () => {
	const dirs: string[] = []

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
	})

	function makeRepo(remote: string): string {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-scoped-searcher-"))
		dirs.push(dir)
		const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" })
		run(["init", "--quiet"])
		run(["remote", "add", "origin", remote])
		return dir
	}

	const embedder: SharedEmbedder = {
		embedQuery: async (text) => [text.length],
		embedDocuments: async (texts) => texts.map((t) => [t.length]),
	}

	/** A backend stub carrying the fact text its searches return. */
	function fakeBackend(memory: string, score = 0.5): ScopedBackend {
		return {
			search: async () => ({ results: [{ id: `${memory}-id`, memory, score }] }),
		}
	}

	it("wires ONE shared embedder instance into both store backends", async () => {
		const repo = makeRepo("https://github.com/cur/proj.git")
		const created: Array<{ dbPath: string; sharedEmbedder?: SharedEmbedder }> = []
		const searcher = await createScopedSearcher(repo, {
			createSharedEmbedder: async () => embedder,
			createMemoryBackend: async (options) => {
				created.push({ dbPath: options.dbPath, sharedEmbedder: options.sharedEmbedder })
				return options.dbPath === digestDbPath() ? fakeBackend("personal fact") : fakeBackend("project fact", 0.6)
			},
		})
		// Personal store plus the cwd's project store, both carrying the SAME
		// embedder — the wiring that makes each lookup embed its query once.
		expect(created.map((c) => c.dbPath)).toEqual([digestDbPath(), projectDbPath("cur/proj")])
		expect(created[0]?.sharedEmbedder).toBe(embedder)
		expect(created[1]?.sharedEmbedder).toBe(created[0]?.sharedEmbedder)
		// And the merged search works over both.
		const hits = await searcher.search("anything")
		expect(hits.map((h) => h.memory)).toEqual(["project fact", "personal fact"])
	})

	it("a project-store failure degrades to personal-only, logged once", async () => {
		const repo = makeRepo("https://github.com/cur/proj.git")
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const searcher = await createScopedSearcher(repo, {
				createSharedEmbedder: async () => embedder,
				createMemoryBackend: async (options) => {
					if (options.dbPath !== digestDbPath()) throw new Error("project store unavailable")
					return fakeBackend("personal fact")
				},
			})
			const hits = await searcher.search("anything")
			expect(hits.map((h) => h.memory)).toEqual(["personal fact"])
			expect(errorSpy).toHaveBeenCalledTimes(1)
			expect(String(errorSpy.mock.calls[0])).toContain("continuing personal-only")
		} finally {
			errorSpy.mockRestore()
		}
	})
})
