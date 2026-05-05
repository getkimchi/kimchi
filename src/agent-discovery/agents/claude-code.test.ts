import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverAgent } from "../index.js"
import { makeClaudeCodeDefinition } from "./claude-code.js"

describe("claudeCode AgentDefinition", () => {
	let tempDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-cc-test-"))
		configPath = join(tempDir, ".claude.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	function write(data: unknown) {
		writeFileSync(configPath, JSON.stringify(data))
	}

	const cases: Record<
		string,
		{
			config: unknown
			skillsDirs?: (tempDir: string) => string[]
			assert: (result: ReturnType<typeof discoverAgent>) => void
		}
	> = {
		"server only at top-level is discovered": {
			config: {
				mcpServers: { github: { url: "https://api.github.com/mcp" } },
			},
			assert(result) {
				expect(result.mcpServers.github).toMatchObject({ url: "https://api.github.com/mcp" })
			},
		},
		"project-level entry wins over same-name top-level entry": {
			config: {
				projects: {
					"/my/project": { mcpServers: { tool: { command: "project-tool" } } },
				},
				mcpServers: { tool: { command: "top-level-tool" } },
			},
			assert(result) {
				expect(result.mcpServers.tool).toMatchObject({ command: "project-tool" })
			},
		},
		"URL server with Authorization: Bearer sets auth bearer": {
			config: {
				mcpServers: {
					svc: { url: "https://example.com/mcp", headers: { Authorization: "Bearer secret123" } },
				},
			},
			assert(result) {
				expect(result.mcpServers.svc).toMatchObject({ auth: "bearer" })
			},
		},
		"URL server with authorization: bearer (lowercase) sets auth bearer": {
			config: {
				mcpServers: {
					svc: { url: "https://example.com/mcp", headers: { authorization: "bearer secret123" } },
				},
			},
			assert(result) {
				expect(result.mcpServers.svc).toMatchObject({ auth: "bearer" })
			},
		},
		"URL server with Authorization: Basic does not set auth": {
			config: {
				mcpServers: {
					svc: { url: "https://example.com/mcp", headers: { Authorization: "Basic dXNlcjpwYXNz" } },
				},
			},
			assert(result) {
				expect(result.mcpServers.svc?.auth).toBeUndefined()
			},
		},
		"URL server with no headers does not set auth": {
			config: {
				mcpServers: { svc: { url: "https://example.com/mcp" } },
			},
			assert(result) {
				expect(result.mcpServers.svc?.auth).toBeUndefined()
			},
		},
		"stdio server with Authorization header does not set auth": {
			config: {
				mcpServers: {
					svc: { command: "my-tool", headers: { Authorization: "Bearer secret123" } },
				},
			},
			assert(result) {
				expect(result.mcpServers.svc?.auth).toBeUndefined()
			},
		},
		"skills dir present → skillsDir is set to the skills path": {
			config: {
				mcpServers: { github: { url: "https://api.github.com/mcp" } },
			},
			skillsDirs: (tempDir: string) => {
				const dir = join(tempDir, "skills")
				mkdirSync(dir, { recursive: true })
				mkdirSync(join(dir, "skill-a"), { recursive: true })
				mkdirSync(join(dir, "skill-b"), { recursive: true })
				return [dir, join(tempDir, "nonexistent")]
			},
			assert(result) {
				const skillsDir = result.skillsDir
				expect(skillsDir).toBeDefined()
				expect(skillsDir?.endsWith("skills")).toBe(true)
				expect(result.skillCount).toBe(2)
			},
		},
		"skills dir absent → skillsDir undefined": {
			config: {
				mcpServers: { github: { url: "https://api.github.com/mcp" } },
			},
			skillsDirs: () => [join(tempDir, "nonexistent")],
			assert(result) {
				expect(result.skillsDir).toBeUndefined()
				expect(result.skillCount).toBe(0)
			},
		},
		"malformed entries (null, array, string) are skipped without crashing": {
			config: {
				mcpServers: {
					bad1: null,
					bad2: ["array"],
					bad3: "string",
					good: { command: "ok-tool" },
				},
			},
			assert(result) {
				expect(result.mcpServers.bad1).toBeUndefined()
				expect(result.mcpServers.bad2).toBeUndefined()
				expect(result.mcpServers.bad3).toBeUndefined()
				expect(result.mcpServers.good).toMatchObject({ command: "ok-tool" })
			},
		},
	}

	for (const [name, tc] of Object.entries(cases)) {
		it(name, () => {
			write(tc.config)
			const skillsDirs = tc.skillsDirs ? tc.skillsDirs(tempDir) : undefined
			const def = makeClaudeCodeDefinition(
				skillsDirs ? { configPaths: [configPath], skillsDirs } : { configPaths: [configPath] },
			)
			tc.assert(discoverAgent(def))
		})
	}
})
