import { reconstructToolMetadata, serializeTools } from "pi-mcp-adapter/metadata-cache"
import type { McpTool, ServerCacheEntry, ServerEntry, ToolPrefix } from "pi-mcp-adapter/types"
import { describe, expect, it } from "vitest"

// Kimchi disables the MCP UI standard in the published adapter via the
// dependency patch (see docs/mcp-adapter-audit.md): the harness does not yet
// properly support MCP Apps, so UI-decorated tools must degrade to plain
// tools with inline results. This file pins that patched behavior — a failure
// here means the patch stopped applying or an adapter upgrade re-enabled UI
// discovery.

const definition: Pick<ServerEntry, "exposeResources" | "includeTools" | "excludeTools" | "toolPrefix"> = {}

function uiTool(name: string, meta: Record<string, unknown>): McpTool {
	return {
		name,
		description: `Fixture tool ${name}`,
		inputSchema: { type: "object" as const, properties: {} },
		_meta: meta,
	}
}

describe("MCP UI disable: discovery and cache", () => {
	it("never persists UI resource metadata for UI-decorated tools", () => {
		const cached = serializeTools([
			uiTool("open_ui", { ui: { resourceUri: "ui://fixture/app", streamMode: "eager" } }),
			uiTool("legacy_meta", { "ui/resourceUri": "ui://fixture/app" }),
		])

		expect(cached).toHaveLength(2)
		for (const entry of cached) {
			expect(entry.uiResourceUri).toBeUndefined()
			expect(entry.uiStreamMode).toBeUndefined()
		}
	})

	it("keeps UI visibility metadata so app-only tools stay hidden without a UI host", () => {
		const cached = serializeTools([
			uiTool("open_ui", { ui: { resourceUri: "ui://fixture/app", visibility: ["model"] } }),
		])

		expect(cached[0]?.uiVisibility).toEqual(["model"])
	})

	it("tolerates invalid UI resource metadata instead of failing the tool", () => {
		// Stock 2.34.0 throws on a non-ui:// resourceUri; the disable never
		// reads UI metadata, so malformed declarations cannot break discovery.
		const cached = serializeTools([uiTool("broken_ui", { ui: { resourceUri: "https://example.com/app" } })])

		expect(cached[0]?.name).toBe("broken_ui")
		expect(cached[0]?.uiResourceUri).toBeUndefined()
	})

	it("reconstructs pre-disable cached tools without reviving UI resources", () => {
		// `CachedTool` must keep the optional uiResourceUri/uiStreamMode/uiVisibility
		// fields so pre-disable caches still deserialize; removing them from the
		// adapter's types fails this test at compile time, by design.
		const entry: ServerCacheEntry = {
			configHash: "fixture-hash",
			tools: [
				{
					name: "open_ui",
					uiResourceUri: "ui://fixture/app",
					uiStreamMode: "eager",
					uiVisibility: ["model"],
				},
				{ name: "app_only", uiVisibility: ["app"] },
				{ name: "plain" },
			],
			resources: [],
			cachedAt: Date.now(),
		}

		const prefix: ToolPrefix = "server"
		const metadata = reconstructToolMetadata("fixture", entry, prefix, definition)

		const openUi = metadata.find((tool) => tool.originalName === "open_ui")
		expect(openUi).toBeDefined()
		expect(openUi?.uiResourceUri).toBeUndefined()
		expect(openUi?.uiStreamMode).toBeUndefined()

		// App-only tools remain filtered: they are unusable without a UI host.
		expect(metadata.some((tool) => tool.originalName === "app_only")).toBe(false)
		expect(metadata.some((tool) => tool.originalName === "plain")).toBe(true)
	})
})
