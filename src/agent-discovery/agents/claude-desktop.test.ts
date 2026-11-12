import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverAgent } from "../index.js"
import { makeClaudeDesktopDefinition, scanDesktopPluginConfigs, scanDesktopSkillDirs } from "./claude-desktop.js"

function writeSkillFile(skillsDir: string, name: string, description: string): void {
	mkdirSync(join(skillsDir, name), { recursive: true })
	writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`)
}

function writeJson(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, JSON.stringify(data))
}

describe("claude-desktop discovery", () => {
	let tempDir: string
	let supportDir: string

	beforeEach(() => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-claude-desktop-")))
		supportDir = join(tempDir, "Claude")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("returns nothing importable when the support directory is absent", () => {
		expect(scanDesktopSkillDirs(supportDir)).toEqual([])
		expect(scanDesktopPluginConfigs(supportDir)).toEqual([])

		const discovery = discoverAgent(makeClaudeDesktopDefinition({ supportDir }))
		expect(discovery.mcpServers).toEqual({})
		expect(discovery.skills).toEqual([])
		expect(discovery.skillCount).toBe(0)
	})

	it("discovers MCP servers from claude_desktop_config.json", () => {
		writeJson(join(supportDir, "claude_desktop_config.json"), {
			mcpServers: {
				filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
				pages: { url: "https://mcp.pages.example/mcp", headers: { Authorization: "Bearer tok123" } },
			},
			preferences: { hidden: true },
		})

		const discovery = discoverAgent(makeClaudeDesktopDefinition({ supportDir }))
		expect(discovery.id).toBe("claude-desktop")
		expect(discovery.displayName).toBe("Claude Desktop")
		expect(discovery.mcpServers.filesystem).toMatchObject({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
		})
		expect(discovery.mcpServers.pages).toMatchObject({ url: "https://mcp.pages.example/mcp", auth: "bearer" })
	})

	it("merges skills from the skills-plugin bundle and every rpm plugin", () => {
		const sessions = join(supportDir, "local-agent-mode-sessions")
		writeSkillFile(join(sessions, "skills-plugin", "u1", "u2", "skills"), "learn", "Account learning skill")
		writeSkillFile(
			join(sessions, "u1", "u2", "rpm", "plugin_example", "skills"),
			"example-plugin-skill",
			"Bundled plugin skill",
		)
		writeSkillFile(join(sessions, "u3", "rpm", "plugin_other", "skills"), "other-tool", "Plugin nested one level up")
		writeJson(join(sessions, "u1", "u2", "rpm", "plugin_example", "mcp.json"), {
			mcpServers: { "plugin-server": { url: "https://plugin.example/mcp" } },
		})

		const discovery = discoverAgent(makeClaudeDesktopDefinition({ supportDir }))
		const skillNames = discovery.skills.map((s) => s.name)
		expect(skillNames).toContain("learn")
		expect(skillNames).toContain("example-plugin-skill")
		expect(skillNames).toContain("other-tool")
		expect(discovery.skillCount).toBe(3)
		expect(discovery.mcpServers["plugin-server"]).toMatchObject({ url: "https://plugin.example/mcp" })
	})

	it("dedupes skill names across merged roots, first-writer-wins", () => {
		const sessions = join(supportDir, "local-agent-mode-sessions")
		writeSkillFile(join(sessions, "skills-plugin", "u1", "u2", "skills"), "dup", "from account bundle")
		writeSkillFile(join(sessions, "u1", "rpm", "plugin_x", "skills"), "dup", "from plugin")

		const discovery = discoverAgent(makeClaudeDesktopDefinition({ supportDir }))
		const dups = discovery.skills.filter((s) => s.name === "dup")
		expect(dups).toHaveLength(1)
		expect(dups[0].description).toBe("from account bundle")
	})

	it("without mergeAllSkillsDirs the engine keeps the first-existing-wins behaviour", () => {
		const skillsA = join(tempDir, "a")
		const skillsB = join(tempDir, "b")
		writeSkillFile(skillsA, "alpha", "a")
		writeSkillFile(skillsB, "beta", "b")

		const def = makeClaudeDesktopDefinition({ supportDir, skillsDirs: [skillsA, skillsB] }) as Omit<
			ReturnType<typeof makeClaudeDesktopDefinition>,
			"mergeAllSkillsDirs"
		> & { mergeAllSkillsDirs?: boolean }
		def.mergeAllSkillsDirs = undefined

		const discovery = discoverAgent(def)
		expect(discovery.skills.map((s) => s.name)).toEqual(["alpha"])
	})

	it("scan finds both uuid-depth layouts and tolerates extra nesting", () => {
		const sessions = join(supportDir, "local-agent-mode-sessions")
		writeSkillFile(join(sessions, "skills-plugin", "u1", "u2", "skills"), "learn", "x")
		writeSkillFile(join(sessions, "u1", "u2", "rpm", "plugin_example", "skills"), "sm", "x")

		const dirs = scanDesktopSkillDirs(supportDir)
		expect(dirs).toHaveLength(2)

		const pluginConfigs = scanDesktopPluginConfigs(supportDir)
		expect(pluginConfigs).toEqual([])
		writeJson(join(sessions, "u1", "u2", "rpm", "plugin_example", "mcp.json"), {
			mcpServers: { "plugin-server": { url: "https://plugin.example/mcp" } },
		})
		expect(scanDesktopPluginConfigs(supportDir)).toEqual([
			join(sessions, "u1", "u2", "rpm", "plugin_example", "mcp.json"),
		])
	})
})
