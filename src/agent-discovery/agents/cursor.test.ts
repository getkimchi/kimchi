import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AGENT_DEFINITIONS, discoverAgent } from "../index.js"
import { makeClaudeCodeDefinition } from "./claude-code.js"
import { makeCursorDefinition } from "./cursor.js"
import { makeOpenCodeDefinition } from "./opencode.js"

describe("cursor AgentDefinition", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-cursor-test-"))
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	function configPath(name = "mcp.json"): string {
		return join(tempDir, name)
	}

	function writeConfig(path: string, data: unknown): void {
		writeFileSync(path, JSON.stringify(data))
	}

	function mkSkillsDir(name = "skills", subdirs: string[] = []): string {
		const dir = join(tempDir, name)
		mkdirSync(dir, { recursive: true })
		for (const s of subdirs) {
			mkdirSync(join(dir, s), { recursive: true })
		}
		return dir
	}

	it("discovers stdio MCP servers from mcpServers", () => {
		const path = configPath()
		writeConfig(path, {
			mcpServers: {
				github: {
					command: "npx",
					args: ["-y", "@modelcontextprotocol/server-github"],
					env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${env:GITHUB_TOKEN}" },
				},
			},
		})
		const result = discoverAgent(makeCursorDefinition({ configPaths: [path] }))
		expect(result.id).toBe("cursor")
		expect(result.displayName).toBe("Cursor")
		expect(result.mcpServers.github).toMatchObject({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-github"],
			env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${env:GITHUB_TOKEN}" },
		})
	})

	it("discovers remote servers with bearer auth", () => {
		const path = configPath()
		writeConfig(path, {
			mcpServers: {
				svc: { url: "https://example.com/mcp", headers: { Authorization: "Bearer secret" } },
			},
		})
		const result = discoverAgent(makeCursorDefinition({ configPaths: [path] }))
		expect(result.mcpServers.svc).toMatchObject({ url: "https://example.com/mcp", auth: "bearer" })
	})

	it("skips disabled servers", () => {
		const path = configPath()
		writeConfig(path, {
			mcpServers: {
				off: { command: "npx", disabled: true },
				on: { command: "tool" },
			},
		})
		const result = discoverAgent(makeCursorDefinition({ configPaths: [path] }))
		expect(result.mcpServers.off).toBeUndefined()
		expect(result.mcpServers.on).toMatchObject({ command: "tool" })
	})

	it("merges configs with earlier configPaths winning on name collision", () => {
		const path1 = configPath("primary.json")
		const path2 = configPath("fallback.json")
		writeConfig(path1, { mcpServers: { shared: { command: "primary" } } })
		writeConfig(path2, { mcpServers: { shared: { command: "fallback" }, other: { command: "ok" } } })
		const result = discoverAgent(makeCursorDefinition({ configPaths: [path1, path2] }))
		expect(result.mcpServers.shared).toMatchObject({ command: "primary" })
		expect(result.mcpServers.other).toMatchObject({ command: "ok" })
	})

	it("returns empty discovery when no config exists", () => {
		const result = discoverAgent(
			makeCursorDefinition({
				configPaths: [join(tempDir, "missing.json")],
				skillsDirs: [join(tempDir, "missing-skills")],
			}),
		)
		expect(result.mcpServers).toEqual({})
		expect(result.skillCount).toBe(0)
		expect(result.skillsDir).toBeUndefined()
	})

	it("counts skill subdirectories under ~/.cursor/skills", () => {
		const dir = mkSkillsDir("cursor-skills", ["deploy", "review", "test-gen"])
		const result = discoverAgent(
			makeCursorDefinition({
				configPaths: [join(tempDir, "none.json")],
				skillsDirs: [dir, join(tempDir, "no")],
			}),
		)
		expect(result.skillCount).toBe(3)
		expect(result.skillsDir).toBe(dir)
	})

	it("skips malformed mcpServers entries without crashing", () => {
		const path = configPath()
		writeConfig(path, {
			mcpServers: {
				bad1: null,
				bad2: ["array"],
				good: { command: "ok-tool" },
			},
		})
		const result = discoverAgent(makeCursorDefinition({ configPaths: [path] }))
		expect(result.mcpServers.bad1).toBeUndefined()
		expect(result.mcpServers.bad2).toBeUndefined()
		expect(result.mcpServers.good).toMatchObject({ command: "ok-tool" })
	})

	it("ignores top-level keys other than mcpServers", () => {
		const path = configPath()
		writeConfig(path, { version: 1, servers: { ghost: { command: "x" } } })
		const result = discoverAgent(makeCursorDefinition({ configPaths: [path] }))
		expect(result.mcpServers).toEqual({})
	})

	it("is registered once after Claude Code and OpenCode, before skills-only agents", () => {
		const ids = AGENT_DEFINITIONS.map((d) => d.id)
		expect(ids.indexOf("claude-code")).toBe(0)
		expect(ids.indexOf("opencode")).toBe(1)
		expect(ids.indexOf("cursor")).toBe(2)
		expect(ids.filter((id) => id === "cursor").length).toBe(1)
		expect(ids.indexOf("codex")).toBeGreaterThan(ids.indexOf("cursor"))
	})

	// Documents expected merge priority (CC > OC > Cursor). Reimplements setup-wizard
	// merge order because mergeDiscoveries is not exported for direct testing.
	it("loses cross-agent MCP name collisions to Claude Code and OpenCode", () => {
		const ccPath = join(tempDir, ".claude.json")
		const ocPath = join(tempDir, "opencode.json")
		const cursorPath = configPath()
		writeFileSync(ccPath, JSON.stringify({ mcpServers: { shared: { command: "cc" } } }))
		writeFileSync(ocPath, JSON.stringify({ mcp: { shared: { type: "local", command: ["oc"] } } }))
		writeConfig(cursorPath, { mcpServers: { shared: { command: "cursor" }, cursorOnly: { command: "cursor-only" } } })

		const merged: Record<string, { command?: string }> = {}
		const origins: Record<string, string> = {}
		const defs = [
			makeClaudeCodeDefinition({ configPaths: [ccPath] }),
			makeOpenCodeDefinition({ configPaths: [ocPath] }),
			makeCursorDefinition({ configPaths: [cursorPath] }),
		]
		for (let i = defs.length - 1; i >= 0; i--) {
			const discovered = discoverAgent(defs[i])
			for (const name of Object.keys(discovered.mcpServers)) {
				merged[name] = discovered.mcpServers[name]
				origins[name] = discovered.displayName
			}
		}

		expect(merged.shared).toMatchObject({ command: "cc" })
		expect(origins.shared).toBe("Claude Code")
		expect(merged.cursorOnly).toMatchObject({ command: "cursor-only" })
		expect(origins.cursorOnly).toBe("Cursor")
	})
})
