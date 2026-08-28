import { describe, expect, it } from "vitest"
import { buildProxyDescription } from "./direct-tools.js"
import type { MetadataCache } from "./metadata-cache.js"
import type { McpConfig } from "./types.js"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(servers: Record<string, unknown>): McpConfig {
	return { mcpServers: servers as McpConfig["mcpServers"] }
}

function makeCache(servers: Record<string, unknown>): MetadataCache {
	return { version: 1, servers: servers as MetadataCache["servers"] }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildProxyDescription", () => {
	describe("lazy server visibility", () => {
		it("lists lazy servers (no cached metadata) with (lazy) marker", () => {
			const config = makeConfig({
				"eager-server": { command: "npx", args: ["-y", "some-server"] },
				"lazy-server": { command: "npx", args: ["-y", "lazy-server"] },
			})
			const cache = makeCache({
				"eager-server": {
					configHash: "abc",
					tools: [{ name: "do_thing", description: "Does a thing" }],
					resources: [],
					cachedAt: Date.now(),
				},
			})

			const desc = buildProxyDescription(config, cache, [])

			expect(desc).toContain("eager-server (1 tools)")
			expect(desc).toContain("lazy-server (lazy)")
			expect(desc).toContain("Servers:")
		})

		it("lists multiple lazy servers", () => {
			const config = makeConfig({
				"lazy-a": { command: "npx", args: ["-y", "a"] },
				"lazy-b": { url: "https://example.com/mcp" },
			})
			const cache = makeCache({})

			const desc = buildProxyDescription(config, cache, [])

			expect(desc).toContain("lazy-a (lazy)")
			expect(desc).toContain("lazy-b (lazy)")
		})
	})

	describe("eager-only behaviour unchanged", () => {
		it("lists only cached servers when no lazy servers configured", () => {
			const config = makeConfig({
				"server-a": { command: "npx", args: ["-y", "a"] },
				"server-b": { command: "npx", args: ["-y", "b"] },
			})
			const cache = makeCache({
				"server-a": {
					configHash: "abc",
					tools: [{ name: "tool_a", description: "Tool A" }],
					resources: [],
					cachedAt: Date.now(),
				},
				"server-b": {
					configHash: "def",
					tools: [
						{ name: "tool_b1", description: "Tool B1" },
						{ name: "tool_b2", description: "Tool B2" },
					],
					resources: [],
					cachedAt: Date.now(),
				},
			})

			const desc = buildProxyDescription(config, cache, [])

			expect(desc).toContain("server-a (1 tools)")
			expect(desc).toContain("server-b (2 tools)")
			expect(desc).not.toContain("(lazy)")
		})

		it("produces no Servers line when no servers configured", () => {
			const config = makeConfig({})
			const cache = makeCache({})

			const desc = buildProxyDescription(config, cache, [])

			expect(desc).not.toContain("Servers:")
		})

		it("does not label cached-but-empty servers as lazy", () => {
			const config = makeConfig({
				"empty-cached": { command: "npx", args: ["-y", "empty"] },
				"lazy-server": { command: "npx", args: ["-y", "lazy"] },
			})
			const cache = makeCache({
				"empty-cached": {
					configHash: "abc",
					tools: [],
					resources: [],
					cachedAt: Date.now(),
				},
			})

			const desc = buildProxyDescription(config, cache, [])

			expect(desc).not.toContain("empty-cached")
			expect(desc).toContain("lazy-server (lazy)")
		})
	})
})
