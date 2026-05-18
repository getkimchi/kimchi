import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadProjectContextFiles } from "./context-files.js"

describe("loadProjectContextFiles", () => {
	const tmpBase = join(import.meta.dirname, "__test_tmp_context__")
	const nested = join(tmpBase, "a", "b", "c")

	beforeEach(() => {
		mkdirSync(nested, { recursive: true })
	})

	afterEach(() => {
		rmSync(tmpBase, { recursive: true, force: true })
	})

	it("returns empty array when no context files exist", () => {
		const result = loadProjectContextFiles(nested)
		// May pick up AGENTS.md from ancestor dirs in the real repo,
		// but none from within our temp tree
		const inTmp = result.filter((f) => f.path.startsWith(tmpBase))
		expect(inTmp).toEqual([])
	})

	it("discovers AGENTS.md in cwd", () => {
		writeFileSync(join(nested, "AGENTS.md"), "# Project rules")
		const result = loadProjectContextFiles(nested)
		const inTmp = result.filter((f) => f.path.startsWith(tmpBase))
		expect(inTmp).toHaveLength(1)
		expect(inTmp[0].path).toBe(join(nested, "AGENTS.md"))
		expect(inTmp[0].content).toBe("# Project rules")
	})

	it("discovers CLAUDE.md when AGENTS.md is absent", () => {
		writeFileSync(join(nested, "CLAUDE.md"), "# Claude rules")
		const result = loadProjectContextFiles(nested)
		const inTmp = result.filter((f) => f.path.startsWith(tmpBase))
		expect(inTmp).toHaveLength(1)
		expect(inTmp[0].path).toBe(join(nested, "CLAUDE.md"))
	})

	it("prefers AGENTS.md over CLAUDE.md in the same directory", () => {
		writeFileSync(join(nested, "AGENTS.md"), "agents wins")
		writeFileSync(join(nested, "CLAUDE.md"), "claude loses")
		const result = loadProjectContextFiles(nested)
		const inTmp = result.filter((f) => f.path.startsWith(tmpBase))
		expect(inTmp).toHaveLength(1)
		expect(inTmp[0].path).toBe(join(nested, "AGENTS.md"))
	})

	it("collects files from multiple ancestor directories in root-to-cwd order", () => {
		const parentDir = join(tmpBase, "a")
		writeFileSync(join(parentDir, "AGENTS.md"), "parent rules")
		writeFileSync(join(nested, "CLAUDE.md"), "child rules")
		const result = loadProjectContextFiles(nested)
		const inTmp = result.filter((f) => f.path.startsWith(tmpBase))
		expect(inTmp).toHaveLength(2)
		// Ancestor first, child last
		expect(inTmp[0].path).toBe(join(parentDir, "AGENTS.md"))
		expect(inTmp[1].path).toBe(join(nested, "CLAUDE.md"))
	})

	it("does not return duplicate paths", () => {
		writeFileSync(join(tmpBase, "AGENTS.md"), "root level")
		const result = loadProjectContextFiles(tmpBase)
		const inTmp = result.filter((f) => f.path.startsWith(tmpBase))
		const paths = inTmp.map((f) => f.path)
		expect(new Set(paths).size).toBe(paths.length)
	})
})
