import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const FAKE_AGENT_DIR = join(tmpdir(), `kimchi-global-context-${Date.now()}`)
const tmpBase = join(tmpdir(), `kimchi-project-context-${Date.now()}`)
const nested = join(tmpBase, "a", "b", "c")

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return { ...actual, getAgentDir: () => FAKE_AGENT_DIR }
})

import { loadGlobalContextFiles, loadProjectContextFiles } from "./context-files.js"

describe("loadProjectContextFiles", () => {
	beforeEach(() => {
		rmSync(tmpBase, { recursive: true, force: true })
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

	it("appends CLAUDE.local.md content to CLAUDE.md when both exist", () => {
		writeFileSync(join(nested, "CLAUDE.md"), "shared rules")
		writeFileSync(join(nested, "CLAUDE.local.md"), "my local rules")
		const result = loadProjectContextFiles(nested)
		const inTmp = result.filter((f) => f.path.startsWith(tmpBase))
		expect(inTmp).toHaveLength(1)
		expect(inTmp[0].path).toBe(join(nested, "CLAUDE.md"))
		expect(inTmp[0].content).toBe("shared rules\n\nmy local rules")
	})

	it("appends AGENTS.local.md content to AGENTS.md when both exist", () => {
		writeFileSync(join(nested, "AGENTS.md"), "shared agents")
		writeFileSync(join(nested, "AGENTS.local.md"), "my local agents")
		const result = loadProjectContextFiles(nested)
		const inTmp = result.filter((f) => f.path.startsWith(tmpBase))
		expect(inTmp).toHaveLength(1)
		expect(inTmp[0].path).toBe(join(nested, "AGENTS.md"))
		expect(inTmp[0].content).toBe("shared agents\n\nmy local agents")
	})

	it("loads CLAUDE.local.md standalone when CLAUDE.md is absent", () => {
		writeFileSync(join(nested, "CLAUDE.local.md"), "only local")
		const result = loadProjectContextFiles(nested)
		const inTmp = result.filter((f) => f.path.startsWith(tmpBase))
		expect(inTmp).toHaveLength(1)
		expect(inTmp[0].path).toBe(join(nested, "CLAUDE.local.md"))
		expect(inTmp[0].content).toBe("only local")
	})

	it("ignores CLAUDE.local.md when AGENTS.md wins priority in same dir", () => {
		writeFileSync(join(nested, "AGENTS.md"), "agents wins")
		writeFileSync(join(nested, "CLAUDE.local.md"), "claude local ignored")
		const result = loadProjectContextFiles(nested)
		const inTmp = result.filter((f) => f.path.startsWith(tmpBase))
		expect(inTmp).toHaveLength(1)
		expect(inTmp[0].path).toBe(join(nested, "AGENTS.md"))
		expect(inTmp[0].content).toBe("agents wins")
	})
})

describe("loadGlobalContextFiles", () => {
	beforeEach(() => {
		rmSync(FAKE_AGENT_DIR, { recursive: true, force: true })
		rmSync(tmpBase, { recursive: true, force: true })
		mkdirSync(FAKE_AGENT_DIR, { recursive: true })
	})

	afterEach(() => {
		rmSync(FAKE_AGENT_DIR, { recursive: true, force: true })
		rmSync(tmpBase, { recursive: true, force: true })
	})

	it("returns empty array when no global context files exist", () => {
		const result = loadGlobalContextFiles()
		expect(result).toEqual([])
	})

	it("discovers AGENTS.md in agent dir", () => {
		writeFileSync(join(FAKE_AGENT_DIR, "AGENTS.md"), "# Global rules")
		const result = loadGlobalContextFiles()
		expect(result).toHaveLength(1)
		expect(result[0].path).toBe(join(FAKE_AGENT_DIR, "AGENTS.md"))
		expect(result[0].content).toBe("# Global rules")
	})

	it("appends AGENTS.local.md content to AGENTS.md when both exist", () => {
		writeFileSync(join(FAKE_AGENT_DIR, "AGENTS.md"), "global shared agents")
		writeFileSync(join(FAKE_AGENT_DIR, "AGENTS.local.md"), "global local agents")
		const result = loadGlobalContextFiles()
		expect(result).toHaveLength(1)
		expect(result[0].path).toBe(join(FAKE_AGENT_DIR, "AGENTS.md"))
		expect(result[0].content).toBe("global shared agents\n\nglobal local agents")
	})

	it("returns global files before project files when combined", () => {
		mkdirSync(nested, { recursive: true })
		writeFileSync(join(FAKE_AGENT_DIR, "AGENTS.md"), "global first")
		writeFileSync(join(nested, "AGENTS.md"), "project second")
		const globalResult = loadGlobalContextFiles()
		const projectResult = loadProjectContextFiles(nested)
		const combined = [...globalResult, ...projectResult]
		const inTmp = combined.filter((f) => f.path.startsWith(FAKE_AGENT_DIR) || f.path.startsWith(tmpBase))
		expect(inTmp).toHaveLength(2)
		expect(inTmp[0].content).toBe("global first")
		expect(inTmp[1].content).toBe("project second")
	})
})
