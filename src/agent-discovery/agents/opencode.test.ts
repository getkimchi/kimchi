import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverAgent } from "../index.js"
import { makeOpenCodeDefinition } from "./opencode.js"

describe("openCode AgentDefinition", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-oc-test-"))
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	// Helpers
	function configPath(name = "opencode.json"): string {
		return join(tempDir, name)
	}

	function skillsPath(name = "skills"): string {
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

	// ---------------------------------------------------------------------------
	// §5.1 Modern (opencode.ai) shape
	// ---------------------------------------------------------------------------

	describe("modern opencode.ai shape", () => {
		it("local server with command array splits into command + args", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					tool: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"] },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.tool.command).toBe("npx")
			expect(result.mcpServers.tool.args).toEqual(["-y", "@modelcontextprotocol/server-everything"])
		})

		it("local server with single-element command sets only command", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					tool: { type: "local", command: ["tool"] },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.tool.command).toBe("tool")
			expect(result.mcpServers.tool.args).toBeUndefined()
		})

		it("local server with empty command array is skipped", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					tool: { type: "local", command: [] },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.tool).toBeUndefined()
		})

		it("local server's environment maps to env", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					tool: { type: "local", command: ["npx"], environment: { FOO: "bar" } },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.tool.env).toEqual({ FOO: "bar" })
		})

		it("remote server with bearer header sets auth bearer", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					svc: { type: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer secret" } },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.svc.auth).toBe("bearer")
		})

		it("remote server with lowercase authorization: bearer sets auth bearer", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					svc: { type: "remote", url: "https://example.com/mcp", headers: { authorization: "bearer token" } },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.svc.auth).toBe("bearer")
		})

		it("remote server with Basic does not set auth", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					svc: { type: "remote", url: "https://example.com/mcp", headers: { Authorization: "Basic dXNlcjpwYXNz" } },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.svc.auth).toBeUndefined()
		})

		it("remote server without headers does not set auth", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					svc: { type: "remote", url: "https://example.com/mcp" },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.svc.auth).toBeUndefined()
		})

		it("remote server with null headers does not crash and sets no auth", () => {
			// Regression: parsed JSON can put `null` where the schema declares an
			// object; `Object.entries(null)` would throw without the engine guard.
			const path = configPath()
			writeConfig(path, {
				mcp: {
					svc: { type: "remote", url: "https://example.com/mcp", headers: null },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.svc.auth).toBeUndefined()
		})

		it("remote server with array headers does not crash and sets no auth", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					svc: { type: "remote", url: "https://example.com/mcp", headers: ["Authorization", "Bearer x"] },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.svc.auth).toBeUndefined()
		})

		it("enabled: false server is skipped", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					tool: { type: "local", command: ["npx"], enabled: false },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.tool).toBeUndefined()
		})

		it("enabled: true is treated the same as missing (kept)", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					tool: { type: "local", command: ["npx"], enabled: true },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.tool).toBeDefined()
			expect(result.mcpServers.tool.command).toBe("npx")
		})

		it("oauth and timeout fields are ignored without crashing", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					svc: {
						type: "remote",
						url: "https://example.com/mcp",
						oauth: { clientId: "abc" },
						timeout: 5000,
					},
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.svc).toBeDefined()
			expect(result.mcpServers.svc.url).toBe("https://example.com/mcp")
		})

		it("{env:VAR} placeholders pass through verbatim", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					svc: {
						type: "remote",
						url: "https://example.com/mcp",
						headers: { Authorization: "Bearer {env:GITHUB_PAT}" },
					},
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.svc.headers?.Authorization).toBe("Bearer {env:GITHUB_PAT}")
		})
	})

	// ---------------------------------------------------------------------------
	// §5.2 Legacy (opencode-ai/opencode) shape
	// ---------------------------------------------------------------------------

	describe("legacy opencode-ai/opencode Go binary shape", () => {
		it("stdio server with env as Record<string,string> passes through", () => {
			const path = configPath()
			writeConfig(path, {
				mcpServers: {
					fs: { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { K: "V" } },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.fs.env).toEqual({ K: "V" })
		})

		it("stdio server with env as string[] array becomes a record", () => {
			const path = configPath()
			writeConfig(path, {
				mcpServers: {
					fs: { type: "stdio", command: "npx", args: ["-y", "pkg"], env: ["K=V", "X=Y"] },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.fs.env).toEqual({ K: "V", X: "Y" })
		})

		it("stdio server with malformed env item drops the item", () => {
			const path = configPath()
			writeConfig(path, {
				mcpServers: {
					fs: { type: "stdio", command: "npx", env: ["NOEQUALS", "K=V"] },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.fs.env).toEqual({ K: "V" })
			expect(result.mcpServers.fs.env?.NOEQUALS).toBeUndefined()
		})

		it("server with null headers does not crash and sets no auth", () => {
			// Regression matching the modern path — see comment above.
			const path = configPath()
			writeConfig(path, {
				mcpServers: {
					remote: { type: "sse", url: "https://api.example.com/mcp", headers: null },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.remote.auth).toBeUndefined()
		})

		it("sse server with bearer header sets auth bearer", () => {
			const path = configPath()
			writeConfig(path, {
				mcpServers: {
					remote: { type: "sse", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer tok" } },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.remote.auth).toBe("bearer")
		})

		it("both mcp and mcpServers present in same file are both ingested", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					modern: { type: "local", command: ["tool"] },
				},
				mcpServers: {
					legacy: { type: "stdio", command: "ls" },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.modern).toBeDefined()
			expect(result.mcpServers.legacy).toBeDefined()
		})
	})

	// ---------------------------------------------------------------------------
	// §5.3 Skills + file/path semantics
	// ---------------------------------------------------------------------------

	describe("skills + file/path semantics", () => {
		it("no config file at any path returns empty discovery", () => {
			const def = makeOpenCodeDefinition({
				configPaths: [join(tempDir, "nonexistent.json")],
				skillsDirs: [join(tempDir, "nonexistent-skills")],
			})
			const result = discoverAgent(def)
			expect(result.mcpServers).toEqual({})
			expect(result.skillCount).toBe(0)
			expect(result.skillsDir).toBeUndefined()
		})

		it("corrupt JSON config emits warning, returns empty", () => {
			const path = configPath()
			writeFileSync(path, "{ not valid json", "utf-8")
			expect(() =>
				discoverAgent(makeOpenCodeDefinition({ configPaths: [path], skillsDirs: [join(tempDir, "no")] })),
			).not.toThrow()
			const def = makeOpenCodeDefinition({ configPaths: [path], skillsDirs: [join(tempDir, "no")] })
			const result = discoverAgent(def)
			expect(result.mcpServers).toEqual({})
		})

		it("JSONC config with // comments is parsed correctly", () => {
			const path = join(tempDir, "opencode.jsonc")
			writeFileSync(
				path,
				JSON.stringify({
					mcp: {
						// My MCP server
						tool: { type: "local", command: ["npx"] },
					},
				}),
				"utf-8",
			)
			// Manually inject // comment
			writeFileSync(
				path,
				'{\n  // comment line\n  "mcp": {\n    "tool": { "type": "local", "command": ["npx"] }\n  }\n}',
				"utf-8",
			)
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.tool).toBeDefined()
		})

		it("skills dir with 3 subdirs returns count 3 + skillsDir set", () => {
			const dir = mkSkillsDir("skills", ["a", "b", "c"])
			const def = makeOpenCodeDefinition({
				configPaths: [join(tempDir, "none.json")],
				skillsDirs: [dir, join(tempDir, "no")],
			})
			const result = discoverAgent(def)
			expect(result.skillCount).toBe(3)
			expect(result.skillsDir).toBe(dir)
		})

		it("skills dir with files (not dirs) inside ignores files", () => {
			const dir = mkSkillsDir("skills")
			writeFileSync(join(dir, "README.md"), "readme")
			const def = makeOpenCodeDefinition({
				configPaths: [join(tempDir, "none.json")],
				skillsDirs: [dir],
			})
			const result = discoverAgent(def)
			expect(result.skillCount).toBe(0)
			expect(result.skillsDir).toBe(dir)
		})

		it("missing skills dir returns no skillsDir", () => {
			const def = makeOpenCodeDefinition({
				configPaths: [join(tempDir, "none.json")],
				skillsDirs: [join(tempDir, "nonexistent-skills")],
			})
			const result = discoverAgent(def)
			expect(result.skillCount).toBe(0)
			expect(result.skillsDir).toBeUndefined()
		})

		it("singular skill/ fallback used when plural skills/ missing", () => {
			const dir = mkSkillsDir("skill", ["alpha", "beta"])
			const def = makeOpenCodeDefinition({
				configPaths: [join(tempDir, "none.json")],
				skillsDirs: [join(tempDir, "skills"), dir],
			})
			const result = discoverAgent(def)
			expect(result.skillCount).toBe(2)
			expect(result.skillsDir).toBe(dir)
		})

		it("first readable config in configPaths wins; later ones not read", () => {
			const path1 = configPath("a.json")
			const path2 = configPath("b.json")
			writeConfig(path1, { mcp: { first: { type: "local", command: ["a"] } } })
			writeConfig(path2, { mcp: { second: { type: "local", command: ["b"] } } })
			const def = makeOpenCodeDefinition({ configPaths: [path1, path2] })
			const result = discoverAgent(def)
			expect(result.mcpServers.first).toBeDefined()
			expect(result.mcpServers.second).toBeUndefined()
		})

		it("malformed entries inside mcp are skipped silently", () => {
			const path = configPath()
			writeConfig(path, {
				mcp: {
					bad1: null,
					bad2: ["array"],
					bad3: "string",
					good: { type: "local", command: ["ok"] },
				},
			})
			const def = makeOpenCodeDefinition({ configPaths: [path] })
			const result = discoverAgent(def)
			expect(result.mcpServers.bad1).toBeUndefined()
			expect(result.mcpServers.bad2).toBeUndefined()
			expect(result.mcpServers.bad3).toBeUndefined()
			expect(result.mcpServers.good).toBeDefined()
		})

		it("empty skills dir still sets skillsDir", () => {
			const dir = mkSkillsDir("skills")
			const def = makeOpenCodeDefinition({
				configPaths: [join(tempDir, "none.json")],
				skillsDirs: [dir],
			})
			const result = discoverAgent(def)
			expect(result.skillCount).toBe(0)
			expect(result.skillsDir).toBe(dir)
		})
	})
})
