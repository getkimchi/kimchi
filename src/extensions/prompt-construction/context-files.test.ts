import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const FAKE_AGENT_DIR = join(tmpdir(), `kimchi-global-context-${Date.now()}`)
const tmpBase = join(tmpdir(), `kimchi-project-context-${Date.now()}`)
const nested = join(tmpBase, "a", "b", "c")

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return { ...actual, getAgentDir: () => FAKE_AGENT_DIR }
})

import { loadContextFiles, loadGlobalContextFiles, loadProjectContextFiles } from "./context-files.js"

describe("loadProjectContextFiles", () => {
	beforeEach(() => {
		rmSync(tmpBase, { recursive: true, force: true })
		mkdirSync(nested, { recursive: true })
	})

	afterEach(() => {
		vi.unstubAllEnvs()
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

	it("skips cwd and every ancestor when review tools are active", () => {
		vi.stubEnv("REVIEW_WRITER", "final")
		writeFileSync(join(tmpBase, "AGENTS.md"), "ancestor rules")
		writeFileSync(join(nested, "CLAUDE.md"), "cwd rules")
		expect(loadProjectContextFiles(nested)).toEqual([])
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
	const FAKE_CLAUDE_DIR = join(tmpdir(), `kimchi-claude-config-${Date.now()}`)
	const on = { includeClaudeCodeInstructions: true }

	beforeEach(() => {
		rmSync(FAKE_AGENT_DIR, { recursive: true, force: true })
		rmSync(FAKE_CLAUDE_DIR, { recursive: true, force: true })
		rmSync(tmpBase, { recursive: true, force: true })
		mkdirSync(FAKE_AGENT_DIR, { recursive: true })
		mkdirSync(FAKE_CLAUDE_DIR, { recursive: true })
		vi.stubEnv("CLAUDE_CONFIG_DIR", FAKE_CLAUDE_DIR)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		rmSync(FAKE_AGENT_DIR, { recursive: true, force: true })
		rmSync(FAKE_CLAUDE_DIR, { recursive: true, force: true })
		rmSync(tmpBase, { recursive: true, force: true })
	})

	it("returns empty array when no global context files exist", () => {
		const result = loadGlobalContextFiles(on)
		expect(result).toEqual([])
	})

	it("skips global and project context when review tools are active", () => {
		vi.stubEnv("REVIEW_WRITER", "final")
		writeFileSync(join(FAKE_AGENT_DIR, "AGENTS.md"), "global rules")
		mkdirSync(nested, { recursive: true })
		writeFileSync(join(nested, "AGENTS.md"), "project rules")
		expect(loadContextFiles(nested, { includeClaudeCodeInstructions: true })).toEqual([])
	})

	it("discovers AGENTS.md in agent dir", () => {
		writeFileSync(join(FAKE_AGENT_DIR, "AGENTS.md"), "# Global rules")
		const result = loadGlobalContextFiles(on)
		expect(result).toHaveLength(1)
		expect(result[0].path).toBe(join(FAKE_AGENT_DIR, "AGENTS.md"))
		expect(result[0].content).toBe("# Global rules")
	})

	it("appends AGENTS.local.md content to AGENTS.md when both exist", () => {
		writeFileSync(join(FAKE_AGENT_DIR, "AGENTS.md"), "global shared agents")
		writeFileSync(join(FAKE_AGENT_DIR, "AGENTS.local.md"), "global local agents")
		const result = loadGlobalContextFiles(on)
		expect(result).toHaveLength(1)
		expect(result[0].path).toBe(join(FAKE_AGENT_DIR, "AGENTS.md"))
		expect(result[0].content).toBe("global shared agents\n\nglobal local agents")
	})

	it("returns global files before project files when combined", () => {
		mkdirSync(nested, { recursive: true })
		writeFileSync(join(FAKE_AGENT_DIR, "AGENTS.md"), "global first")
		writeFileSync(join(nested, "AGENTS.md"), "project second")
		const globalResult = loadGlobalContextFiles(on)
		const projectResult = loadProjectContextFiles(nested)
		const combined = [...globalResult, ...projectResult]
		const inTmp = combined.filter((f) => f.path.startsWith(FAKE_AGENT_DIR) || f.path.startsWith(tmpBase))
		expect(inTmp).toHaveLength(2)
		expect(inTmp[0].content).toBe("global first")
		expect(inTmp[1].content).toBe("project second")
	})

	it("loads CLAUDE.md from the Claude Code config dir", () => {
		writeFileSync(join(FAKE_CLAUDE_DIR, "CLAUDE.md"), "claude rules")
		expect(loadGlobalContextFiles(on)).toEqual([{ path: join(FAKE_CLAUDE_DIR, "CLAUDE.md"), content: "claude rules" }])
	})

	it("puts Claude Code CLAUDE.md before kimchi AGENTS.md", () => {
		writeFileSync(join(FAKE_CLAUDE_DIR, "CLAUDE.md"), "claude rules")
		writeFileSync(join(FAKE_AGENT_DIR, "AGENTS.md"), "kimchi rules")
		expect(loadGlobalContextFiles(on).map((f) => f.content)).toEqual(["claude rules", "kimchi rules"])
	})

	it("skips Claude Code CLAUDE.md when the option is off", () => {
		writeFileSync(join(FAKE_CLAUDE_DIR, "CLAUDE.md"), "claude rules")
		writeFileSync(join(FAKE_AGENT_DIR, "AGENTS.md"), "kimchi rules")
		expect(loadGlobalContextFiles({ includeClaudeCodeInstructions: false }).map((f) => f.content)).toEqual([
			"kimchi rules",
		])
	})

	it("falls back to ~/.claude when CLAUDE_CONFIG_DIR is empty", () => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", "")
		// Unit tests run with an isolated HOME per file, so this never touches the real ~/.claude.
		const homeClaude = join(homedir(), ".claude")
		mkdirSync(homeClaude, { recursive: true })
		writeFileSync(join(homeClaude, "CLAUDE.md"), "home claude")
		try {
			expect(loadGlobalContextFiles(on)[0]).toEqual({ path: join(homeClaude, "CLAUDE.md"), content: "home claude" })
		} finally {
			rmSync(homeClaude, { recursive: true, force: true })
		}
	})

	it("does not read CLAUDE.local.md in the Claude Code dir", () => {
		writeFileSync(join(FAKE_CLAUDE_DIR, "CLAUDE.local.md"), "local only")
		expect(loadGlobalContextFiles(on)).toEqual([])
	})

	it("loads once when AGENTS.md is a symlink to Claude Code CLAUDE.md", () => {
		writeFileSync(join(FAKE_CLAUDE_DIR, "CLAUDE.md"), "shared")
		symlinkSync(join(FAKE_CLAUDE_DIR, "CLAUDE.md"), join(FAKE_AGENT_DIR, "AGENTS.md"))
		expect(loadGlobalContextFiles(on)).toEqual([{ path: join(FAKE_AGENT_DIR, "AGENTS.md"), content: "shared" }])
	})

	it("loads once when both files hold the same text apart from trailing whitespace", () => {
		writeFileSync(join(FAKE_CLAUDE_DIR, "CLAUDE.md"), "same rules\n")
		writeFileSync(join(FAKE_AGENT_DIR, "AGENTS.md"), "same rules")
		expect(loadGlobalContextFiles(on).map((f) => f.path)).toEqual([join(FAKE_AGENT_DIR, "AGENTS.md")])
	})

	it("loads once when a copy differs only by a leading BOM", () => {
		writeFileSync(join(FAKE_CLAUDE_DIR, "CLAUDE.md"), "﻿same rules\n")
		writeFileSync(join(FAKE_AGENT_DIR, "AGENTS.md"), "same rules\n")
		expect(loadGlobalContextFiles(on).map((f) => f.path)).toEqual([join(FAKE_AGENT_DIR, "AGENTS.md")])
	})

	it("skips CLAUDE.md that is a directory", () => {
		mkdirSync(join(FAKE_CLAUDE_DIR, "CLAUDE.md"))
		expect(loadGlobalContextFiles(on)).toEqual([])
	})

	it("skips CLAUDE.md that is a broken symlink", () => {
		symlinkSync(join(FAKE_CLAUDE_DIR, "missing.md"), join(FAKE_CLAUDE_DIR, "CLAUDE.md"))
		expect(loadGlobalContextFiles(on)).toEqual([])
	})
})

describe("loadProjectContextFiles with already loaded global files", () => {
	const globalDir = join(tmpdir(), `kimchi-dedup-global-${Date.now()}`)
	const globalPath = join(globalDir, "CLAUDE.md")
	const globals = [{ path: globalPath, content: "global rules\n" }]
	const inTmp = (files: { path: string }[]) => files.filter((f) => f.path.startsWith(tmpBase))

	beforeEach(() => {
		rmSync(tmpBase, { recursive: true, force: true })
		rmSync(globalDir, { recursive: true, force: true })
		mkdirSync(nested, { recursive: true })
		mkdirSync(globalDir, { recursive: true })
		writeFileSync(globalPath, "global rules\n")
	})

	afterEach(() => {
		rmSync(tmpBase, { recursive: true, force: true })
		rmSync(globalDir, { recursive: true, force: true })
	})

	it("skips a project file that is a symlink to a global file", () => {
		symlinkSync(globalPath, join(nested, "AGENTS.md"))
		expect(inTmp(loadProjectContextFiles(nested, globals))).toEqual([])
	})

	it("skips a project file that copies a global file apart from whitespace", () => {
		writeFileSync(join(nested, "CLAUDE.md"), "global rules")
		expect(inTmp(loadProjectContextFiles(nested, globals))).toEqual([])
	})

	it("keeps the .local.md of a skipped duplicate", () => {
		symlinkSync(globalPath, join(nested, "AGENTS.md"))
		writeFileSync(join(nested, "AGENTS.local.md"), "my overrides")
		expect(inTmp(loadProjectContextFiles(nested, globals))).toEqual([
			{ path: join(nested, "AGENTS.local.md"), content: "my overrides" },
		])
	})

	it("does not fall through to CLAUDE.md when AGENTS.md is a duplicate", () => {
		writeFileSync(join(nested, "AGENTS.md"), "global rules")
		writeFileSync(join(nested, "CLAUDE.md"), "project claude rules")
		expect(inTmp(loadProjectContextFiles(nested, globals))).toEqual([])
	})

	it("keeps project files that differ from the global files", () => {
		writeFileSync(join(nested, "AGENTS.md"), "project rules")
		expect(inTmp(loadProjectContextFiles(nested, globals))).toEqual([
			{ path: join(nested, "AGENTS.md"), content: "project rules" },
		])
	})

	it("loads a duplicate when no global files are given", () => {
		symlinkSync(globalPath, join(nested, "AGENTS.md"))
		expect(inTmp(loadProjectContextFiles(nested))).toEqual([
			{ path: join(nested, "AGENTS.md"), content: "global rules\n" },
		])
	})
})

describe("loadContextFiles with a global AGENTS.local.md", () => {
	const emptyClaudeDir = join(tmpdir(), `kimchi-empty-claude-${Date.now()}`)
	const globalAgents = join(FAKE_AGENT_DIR, "AGENTS.md")
	const load = () =>
		loadContextFiles(nested, { includeClaudeCodeInstructions: true }).filter(
			(f) => f.path.startsWith(FAKE_AGENT_DIR) || f.path.startsWith(tmpBase),
		)

	beforeEach(() => {
		rmSync(FAKE_AGENT_DIR, { recursive: true, force: true })
		rmSync(tmpBase, { recursive: true, force: true })
		mkdirSync(FAKE_AGENT_DIR, { recursive: true })
		mkdirSync(nested, { recursive: true })
		vi.stubEnv("CLAUDE_CONFIG_DIR", emptyClaudeDir)
		writeFileSync(globalAgents, "shared rules\n")
		writeFileSync(join(FAKE_AGENT_DIR, "AGENTS.local.md"), "global local override\n")
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		rmSync(FAKE_AGENT_DIR, { recursive: true, force: true })
		rmSync(tmpBase, { recursive: true, force: true })
	})

	const mergedGlobal = { path: globalAgents, content: "shared rules\n\n\nglobal local override\n" }

	it("skips a project copy of the global AGENTS.md", () => {
		writeFileSync(join(nested, "AGENTS.md"), "shared rules")
		expect(load()).toEqual([mergedGlobal])
	})

	it("skips a project symlink to the global AGENTS.md", () => {
		symlinkSync(globalAgents, join(nested, "AGENTS.md"))
		expect(load()).toEqual([mergedGlobal])
	})

	it("keeps the project AGENTS.local.md of a skipped copy", () => {
		writeFileSync(join(nested, "AGENTS.md"), "shared rules")
		writeFileSync(join(nested, "AGENTS.local.md"), "project local override")
		expect(load()).toEqual([mergedGlobal, { path: join(nested, "AGENTS.local.md"), content: "project local override" }])
	})
})
