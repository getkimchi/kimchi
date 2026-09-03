import type { McpServer } from "@agentclientprotocol/sdk"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convertAcpMcpServers } from "./acp-mcp-convert.js"
import {
	clearCallerMcpServers,
	consumeCallerMcpServers,
	peekCallerMcpServers,
	setCallerMcpServers,
} from "./caller-servers.js"
import { initializeMcp } from "./init.js"
import type { McpExtensionState } from "./state.js"

// ─── Test helpers ───────────────────────────────────────────────────────────

/**
 * Minimal ExtensionAPI stub: returns a temp-dir config path so initializeMcp
 * doesn't pick up the real user's mcp.json. The temp file doesn't exist,
 * so loadMcpConfig returns an empty `{ mcpServers: {} }`.
 */
function makeFakePi(): ExtensionAPI {
	return {
		getFlag: (name: string) => (name === "mcp-config" ? join(tmpDir, "nonexistent-mcp.json") : undefined),
		sendMessage: () => {},
	} as unknown as ExtensionAPI
}

/**
 * Minimal ExtensionContext stub with hasUI: false so initializeMcp takes the
 * headless path (no status bar, no notifications).
 */
function makeFakeCtx(cwd: string = "/tmp"): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		mode: "rpc",
	} as unknown as ExtensionContext
}

// ─── Setup / teardown ───────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
	clearCallerMcpServers()
	tmpDir = mkdtempSync(join(tmpdir(), "acp-mcp-test-"))
})

afterEach(() => {
	clearCallerMcpServers()
	rmSync(tmpDir, { recursive: true, force: true })
	vi.restoreAllMocks()
})

// ─── Integration tests ──────────────────────────────────────────────────────

describe("ACP mcpServers end-to-end pipeline", () => {
	describe("conversion → registry → initializeMcp merge", () => {
		it("converts ACP stdio server and merges it into initializeMcp state", async () => {
			const acpServers: McpServer[] = [
				{
					name: "my-stdio-server",
					command: "/usr/bin/node",
					args: ["server.js"],
					env: [{ name: "API_KEY", value: "secret" }],
				},
			]

			// Step 1: Convert (as the ACP server does)
			const converted = convertAcpMcpServers(acpServers)
			expect(converted).toEqual({
				"my-stdio-server": {
					command: "/usr/bin/node",
					args: ["server.js"],
					env: { API_KEY: "secret" },
				},
			})

			// Step 2: Push onto registry (as newSession/loadSessionFresh does)
			setCallerMcpServers(converted)
			expect(peekCallerMcpServers()).toEqual(converted)

			// Step 3: initializeMcp drains the registry and merges with config
			const pi = makeFakePi()
			const ctx = makeFakeCtx()
			const state: McpExtensionState = await initializeMcp(pi, ctx)

			// Registry is drained
			expect(consumeCallerMcpServers()).toEqual({})

			// The caller-supplied server is in the merged config
			expect(state.config.mcpServers).toHaveProperty("my-stdio-server")
			expect(state.config.mcpServers["my-stdio-server"]).toEqual({
				command: "/usr/bin/node",
				args: ["server.js"],
				env: { API_KEY: "secret" },
			})
		})

		it("converts ACP HTTP server and merges it into initializeMcp state", async () => {
			const acpServers: McpServer[] = [
				{
					name: "my-http-server",
					type: "http",
					url: "https://mcp.example.com/sse",
					headers: [{ name: "Authorization", value: "Bearer token" }],
				},
			]

			const converted = convertAcpMcpServers(acpServers)
			setCallerMcpServers(converted)

			const state = await initializeMcp(makeFakePi(), makeFakeCtx())

			expect(consumeCallerMcpServers()).toEqual({})
			expect(state.config.mcpServers).toHaveProperty("my-http-server")
			expect(state.config.mcpServers["my-http-server"]).toEqual({
				url: "https://mcp.example.com/sse",
				headers: { Authorization: "Bearer token" },
			})
		})

		it("caller server overrides config server with same name (caller-wins)", async () => {
			// Pre-populate a config file with a server named "shared"
			const tmpDir = mkdtempSync(join(tmpdir(), "acp-mcp-merge-"))
			const configPath = join(tmpDir, "mcp.json")
			writeFileSync(
				configPath,
				JSON.stringify({
					mcpServers: {
						shared: { command: "/config/binary", args: ["--config"] },
					},
				}),
			)

			try {
				// Caller supplies a different server with the same name
				const acpServers: McpServer[] = [
					{
						name: "shared",
						command: "/caller/binary",
						args: ["--caller"],
						env: [],
					},
				]

				const converted = convertAcpMcpServers(acpServers)
				setCallerMcpServers(converted)

				// Use a pi stub that returns the temp config path
				const pi = {
					getFlag: (name: string) => (name === "mcp-config" ? configPath : undefined),
					sendMessage: () => {},
				} as unknown as ExtensionAPI

				const state = await initializeMcp(pi, makeFakeCtx())

				// Caller wins: the merged server is the caller's definition
				expect(state.config.mcpServers["shared"]).toEqual({
					command: "/caller/binary",
					args: ["--caller"],
				})
			} finally {
				rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("config-only servers still work when no caller servers are provided", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "acp-mcp-config-only-"))
			const configPath = join(tmpDir, "mcp.json")
			writeFileSync(
				configPath,
				JSON.stringify({
					mcpServers: {
						"config-server": { command: "/bin/echo", args: [] },
					},
				}),
			)

			try {
				// No caller servers — registry is empty
				setCallerMcpServers({})

				const pi = {
					getFlag: (name: string) => (name === "mcp-config" ? configPath : undefined),
					sendMessage: () => {},
				} as unknown as ExtensionAPI

				const state = await initializeMcp(pi, makeFakeCtx())

				expect(state.config.mcpServers).toHaveProperty("config-server")
				expect(state.config.mcpServers["config-server"]).toEqual({
					command: "/bin/echo",
					args: [],
				})
			} finally {
				rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("multiple caller servers all merge into initializeMcp state", async () => {
			const acpServers: McpServer[] = [
				{ name: "a", command: "/bin/a", args: [], env: [] },
				{ name: "b", command: "/bin/b", args: [], env: [] },
				{
					name: "c",
					type: "http",
					url: "https://c.example.com",
					headers: [],
				},
			]

			setCallerMcpServers(convertAcpMcpServers(acpServers))

			const state = await initializeMcp(makeFakePi(), makeFakeCtx())

			expect(Object.keys(state.config.mcpServers).sort()).toEqual(["a", "b", "c"])
		})

		it("empty mcpServers array produces empty registry entry, no servers connected", async () => {
			setCallerMcpServers(convertAcpMcpServers([]))

			const state = await initializeMcp(makeFakePi(), makeFakeCtx())

			// No servers — initializeMcp returns early with empty config
			expect(state.config.mcpServers).toEqual({})
			expect(consumeCallerMcpServers()).toEqual({})
		})

		it("registry is FIFO: two sessions consume in push order", async () => {
			// Simulate two rapid newSession calls (push, push, then consume, consume)
			const servers1 = convertAcpMcpServers([{ name: "first", command: "/bin/first", args: [], env: [] }])
			const servers2 = convertAcpMcpServers([{ name: "second", command: "/bin/second", args: [], env: [] }])

			setCallerMcpServers(servers1)
			setCallerMcpServers(servers2)

			// First initializeMcp consumes "first"
			const state1 = await initializeMcp(makeFakePi(), makeFakeCtx())
			expect(state1.config.mcpServers).toHaveProperty("first")
			expect(state1.config.mcpServers).not.toHaveProperty("second")

			// Second initializeMcp consumes "second"
			const state2 = await initializeMcp(makeFakePi(), makeFakeCtx())
			expect(state2.config.mcpServers).toHaveProperty("second")
			expect(state2.config.mcpServers).not.toHaveProperty("first")

			// Queue is empty
			expect(consumeCallerMcpServers()).toEqual({})
		})
	})

	describe("registry lifecycle on session failure", () => {
		it("queue entry remains if initializeMcp is never called (leak scenario)", () => {
			// This documents the contract: if the ACP server pushes but
			// bindExtensions never fires (e.g. sessionFactory throws), the
			// entry stays in the queue. The ACP server's catch block is
			// responsible for draining it via consumeCallerMcpServers().
			const servers = convertAcpMcpServers([{ name: "leaked", command: "/bin/leak", args: [], env: [] }])
			setCallerMcpServers(servers)

			// Nothing consumed it
			expect(peekCallerMcpServers()).toEqual(servers)

			// The ACP server's catch block drains it
			consumeCallerMcpServers()
			expect(peekCallerMcpServers()).toBeUndefined()
		})

		it("consumeCallerMcpServers on empty queue returns {}", () => {
			expect(consumeCallerMcpServers()).toEqual({})
		})
	})
})

// ─── Imports needed for the temp-dir tests ──────────────────────────────────
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
