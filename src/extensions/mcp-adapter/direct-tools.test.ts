/**
 * Registration-level wire-name collision coverage.
 *
 * Sanitization is not injective: a server exposing `get issue` and `get_issue`
 * produces two specs whose formatToolName result is identical
 * ("rovo_get_issue"). resolveDirectTools' seenNames guard must skip the
 * duplicate with a warning so exactly one tool is registered per wire name.
 *
 * registerAndActivate (index.ts) applies the same rule on the late-registration
 * path via its origins map; stubbing the ExtensionAPI it needs is deliberately
 * out of scope here — see cache-resolver.integration.test.ts.
 */
import { describe, expect, it, vi } from "vitest"
import { resolveDirectTools } from "./direct-tools.js"
import { computeServerHash, type MetadataCache } from "./metadata-cache.js"
import type { McpConfig, ServerEntry } from "./types.js"

const ROVO_DEF: ServerEntry = {
	url: "http://127.0.0.1:64342/sse",
	headers: {},
	directTools: true,
}

function cacheWithTools(tools: Array<{ name: string; description?: string }>): MetadataCache {
	return {
		version: 1,
		servers: {
			rovo: {
				configHash: computeServerHash(ROVO_DEF),
				tools,
				resources: [],
				cachedAt: Date.now(),
			},
		},
	}
}

describe("resolveDirectTools — wire-name collisions", () => {
	it("skips a tool whose sanitized wire name collides with an earlier one from the same server", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const config: McpConfig = { mcpServers: { rovo: ROVO_DEF } }
		const cache = cacheWithTools([
			{ name: "get issue", description: "Fetch an issue" },
			{ name: "get_issue", description: "Fetch an issue (underscored)" },
		])

		const specs = resolveDirectTools(config, cache, "server")

		// "get issue" and "get_issue" both format to "rovo_get_issue"; only the
		// first survives, the duplicate is skipped with a warning.
		expect(specs).toHaveLength(1)
		expect(specs[0]?.prefixedName).toBe("rovo_get_issue")
		expect(specs[0]?.originalName).toBe("get issue")

		expect(warn).toHaveBeenCalledTimes(1)
		const message = String(warn.mock.calls[0]?.[0] ?? "")
		expect(message).toContain("rovo_get_issue")
		expect(message).toContain("skipping duplicate")
		warn.mockRestore()
	})
})
