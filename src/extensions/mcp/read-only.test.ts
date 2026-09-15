import { beforeEach, describe, expect, it, vi } from "vitest"

const cacheState = vi.hoisted(() => ({
	cache: undefined as
		| { servers: Record<string, { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> }> }
		| undefined,
}))

vi.mock("pi-mcp-adapter/metadata-cache", () => ({
	loadMetadataCache: () => cacheState.cache,
}))

import { collectReadOnlyMcpWireNames, isReadOnlyQualifiedMcpTool } from "./read-only.js"

describe("isReadOnlyQualifiedMcpTool", () => {
	it("qualifies any tool with an explicit readOnlyHint, regardless of name", () => {
		expect(isReadOnlyQualifiedMcpTool("deploy_stack", { readOnlyHint: true })).toBe(true)
	})

	it("rejects a convention-matching name when annotations veto it", () => {
		expect(isReadOnlyQualifiedMcpTool("get_full_write_access", { readOnlyHint: false })).toBe(false)
		expect(isReadOnlyQualifiedMcpTool("search_everything", { destructiveHint: false } as never)).toBe(false)
	})

	it("applies the name convention only when the server publishes no annotations", () => {
		for (const name of ["get_issue", "search_docs", "list_repos", "read_file", "fetch_page"]) {
			expect(isReadOnlyQualifiedMcpTool(name, undefined)).toBe(true)
		}
		expect(isReadOnlyQualifiedMcpTool("write_file", undefined)).toBe(false)
		expect(isReadOnlyQualifiedMcpTool("create_pr", undefined)).toBe(false)
	})

	it("warns once per convention-promoted tool", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		isReadOnlyQualifiedMcpTool("get_once", undefined)
		isReadOnlyQualifiedMcpTool("get_once", undefined)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('Tool "get_once" promoted to read-only via name convention'))
		warn.mockRestore()
	})
})

describe("collectReadOnlyMcpWireNames", () => {
	beforeEach(() => {
		cacheState.cache = {
			servers: {
				alpha: { tools: [{ name: "get_issue" }, { name: "create_issue" }, { name: "stats", annotations: { readOnlyHint: true } }] },
				beta: { tools: [{ name: "fetch_items" }] },
				unconfigured: { tools: [{ name: "get_secret" }] },
			},
		}
	})

	it("emits prefixed wire names for qualified tools of configured servers only", () => {
		const names = collectReadOnlyMcpWireNames({
			mcpServers: { alpha: { url: "http://a", disabled: false }, beta: { url: "http://b", disabled: false, toolPrefix: "none" } },
		})
		expect(names.sort()).toEqual(["alpha_get_issue", "alpha_stats", "fetch_items"])
	})

	it("honours the \"mcp\" toolPrefix mode", () => {
		const names = collectReadOnlyMcpWireNames({
			mcpServers: { alpha: { url: "http://a", disabled: false, toolPrefix: "mcp" } },
		})
		expect(names).toEqual(["mcp__alpha_get_issue", "mcp__alpha_stats"])
	})

	it("returns nothing without a cache", () => {
		cacheState.cache = undefined
		expect(collectReadOnlyMcpWireNames({ mcpServers: {} })).toEqual([])
	})
})
