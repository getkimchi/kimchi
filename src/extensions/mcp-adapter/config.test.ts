import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeDirectToolsConfig } from "./config.js"
import type { McpConfig, ServerProvenance } from "./types.js"

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tempDir: string

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "mcp-config-test-"))
})

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true })
})

/** Write a minimal mcp.json to tempDir and return its path. */
function writeMcpFile(servers: Record<string, unknown>): string {
	const filePath = join(tempDir, "mcp.json")
	writeFileSync(filePath, JSON.stringify({ mcpServers: servers }, null, 2), "utf-8")
	return filePath
}

/** Read the mcpServers object back from a file written by writeDirectToolsConfig. */
function readServers(filePath: string): Record<string, unknown> {
	const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>
	return (raw.mcpServers ?? {}) as Record<string, unknown>
}

// ─── writeDirectToolsConfig ───────────────────────────────────────────────────

describe("writeDirectToolsConfig", () => {
	describe("in-memory sync (fullConfig.mcpServers)", () => {
		it("updates fullConfig.mcpServers[name].directTools after writing to disk", () => {
			const filePath = writeMcpFile({
				"my-server": { command: "npx", args: ["my-server"] },
			})

			const fullConfig: McpConfig = {
				mcpServers: {
					"my-server": { command: "npx", args: ["my-server"] },
				},
			}
			const provenance = new Map<string, ServerProvenance>([["my-server", { path: filePath, kind: "user" }]])
			const changes = new Map<string, true | string[] | false>([["my-server", true]])

			writeDirectToolsConfig(changes, provenance, fullConfig)

			expect(fullConfig.mcpServers["my-server"].directTools).toBe(true)
		})

		it("syncs a tool list (string[]) into fullConfig", () => {
			const filePath = writeMcpFile({
				"my-server": { command: "npx", args: ["my-server"] },
			})

			const fullConfig: McpConfig = {
				mcpServers: { "my-server": { command: "npx", args: ["my-server"] } },
			}
			const provenance = new Map<string, ServerProvenance>([["my-server", { path: filePath, kind: "user" }]])
			const changes = new Map<string, true | string[] | false>([["my-server", ["tool_a", "tool_b"]]])

			writeDirectToolsConfig(changes, provenance, fullConfig)

			expect(fullConfig.mcpServers["my-server"].directTools).toEqual(["tool_a", "tool_b"])
		})

		it("syncs false (disable all direct tools) into fullConfig", () => {
			const filePath = writeMcpFile({
				"my-server": { command: "npx", args: ["my-server"], directTools: true },
			})

			const fullConfig: McpConfig = {
				mcpServers: { "my-server": { command: "npx", args: ["my-server"], directTools: true } },
			}
			const provenance = new Map<string, ServerProvenance>([["my-server", { path: filePath, kind: "user" }]])
			const changes = new Map<string, true | string[] | false>([["my-server", false]])

			writeDirectToolsConfig(changes, provenance, fullConfig)

			expect(fullConfig.mcpServers["my-server"].directTools).toBe(false)
		})

		it("syncs multiple servers independently", () => {
			const filePath = writeMcpFile({
				server_a: { command: "npx", args: ["a"] },
				server_b: { command: "npx", args: ["b"] },
			})

			const fullConfig: McpConfig = {
				mcpServers: {
					server_a: { command: "npx", args: ["a"] },
					server_b: { command: "npx", args: ["b"] },
				},
			}
			const provenance = new Map<string, ServerProvenance>([
				["server_a", { path: filePath, kind: "user" }],
				["server_b", { path: filePath, kind: "user" }],
			])
			const changes = new Map<string, true | string[] | false>([
				["server_a", true],
				["server_b", ["tool_x"]],
			])

			writeDirectToolsConfig(changes, provenance, fullConfig)

			expect(fullConfig.mcpServers.server_a.directTools).toBe(true)
			expect(fullConfig.mcpServers.server_b.directTools).toEqual(["tool_x"])
		})

		it("does not sync a server that has no provenance entry", () => {
			const filePath = writeMcpFile({
				"my-server": { command: "npx", args: ["my-server"] },
			})

			const fullConfig: McpConfig = {
				mcpServers: { "my-server": { command: "npx", args: ["my-server"] } },
			}
			// Provenance map is empty — writeDirectToolsConfig should skip silently
			const provenance = new Map<string, ServerProvenance>()
			const changes = new Map<string, true | string[] | false>([["my-server", true]])

			writeDirectToolsConfig(changes, provenance, fullConfig)

			// fullConfig unchanged because prov lookup failed
			expect(fullConfig.mcpServers["my-server"].directTools).toBeUndefined()
			// File also unchanged
			const onDisk = readServers(filePath)
			expect((onDisk["my-server"] as Record<string, unknown>).directTools).toBeUndefined()
		})
	})

	describe("disk writes", () => {
		it("persists directTools to the target config file", () => {
			const filePath = writeMcpFile({
				"my-server": { command: "npx", args: ["my-server"] },
			})

			const fullConfig: McpConfig = {
				mcpServers: { "my-server": { command: "npx", args: ["my-server"] } },
			}
			const provenance = new Map<string, ServerProvenance>([["my-server", { path: filePath, kind: "user" }]])
			const changes = new Map<string, true | string[] | false>([["my-server", true]])

			writeDirectToolsConfig(changes, provenance, fullConfig)

			const onDisk = readServers(filePath)
			expect((onDisk["my-server"] as Record<string, unknown>).directTools).toBe(true)
		})

		it("preserves other server fields when updating directTools", () => {
			const filePath = writeMcpFile({
				"my-server": { command: "npx", args: ["my-server", "--flag"], env: { FOO: "bar" } },
			})

			const fullConfig: McpConfig = {
				mcpServers: {
					"my-server": { command: "npx", args: ["my-server", "--flag"], env: { FOO: "bar" } },
				},
			}
			const provenance = new Map<string, ServerProvenance>([["my-server", { path: filePath, kind: "user" }]])
			const changes = new Map<string, true | string[] | false>([["my-server", true]])

			writeDirectToolsConfig(changes, provenance, fullConfig)

			const onDisk = readServers(filePath)
			const srv = onDisk["my-server"] as Record<string, unknown>
			expect(srv.command).toBe("npx")
			expect(srv.args).toEqual(["my-server", "--flag"])
			expect(srv.env).toEqual({ FOO: "bar" })
			expect(srv.directTools).toBe(true)
		})
	})
})

// ─── loadMcpConfig ────────────────────────────────────────────────────────────
// IMPORT_PATHS is computed once at module-eval time from homedir(), so each test
// that exercises imports must re-evaluate config.ts after pointing HOME at a temp
// dir. We do this with vi.resetModules() + a dynamic import.
describe("loadMcpConfig", () => {
	describe("codex import", () => {
		let originalHome: string | undefined
		let tempHome: string

		beforeEach(() => {
			originalHome = process.env.HOME
			tempHome = mkdtempSync(join(tmpdir(), "mcp-codex-home-"))
			process.env.HOME = tempHome
		})

		afterEach(() => {
			if (originalHome === undefined) delete process.env.HOME
			else process.env.HOME = originalHome
			rmSync(tempHome, { recursive: true, force: true })
		})

		it("merges codex MCP servers from ~/.codex/config.json when imports includes codex", async () => {
			// 1. Write a ~/.codex/config.json containing at least one server entry.
			mkdirSync(join(tempHome, ".codex"), { recursive: true })
			writeFileSync(
				join(tempHome, ".codex", "config.json"),
				JSON.stringify({
					mcpServers: {
						"my-server": { command: "node", args: ["server.js"] },
					},
				}),
				"utf-8",
			)

			// 2. Main config requests the codex import.
			const mainConfigPath = join(tempHome, "mcp.json")
			writeFileSync(mainConfigPath, JSON.stringify({ imports: ["codex"], mcpServers: {} }), "utf-8")

			// 3. Re-evaluate config.ts so IMPORT_PATHS resolves against the temp HOME.
			vi.resetModules()
			const { loadMcpConfig } = await import("./config.js")
			const { config, warnings } = loadMcpConfig(mainConfigPath)

			// 4. Assert the codex MCP servers are merged into the result.
			expect(warnings).toEqual([])
			expect(config.mcpServers["my-server"]).toBeDefined()
			expect(config.mcpServers["my-server"]).toMatchObject({
				command: "node",
				args: ["server.js"],
			})
		})
	})
})
