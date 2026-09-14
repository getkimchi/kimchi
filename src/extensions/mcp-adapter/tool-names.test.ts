import { describe, expect, it, vi } from "vitest"
import { formatToolName, getServerPrefix, isToolExcluded, MAX_TOOL_NAME_LENGTH } from "./tool-names.js"

// Provider-side contract (Anthropic custom tools): ^[a-zA-Z0-9_-]{1,128}$
const PROVIDER_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

describe("getServerPrefix", () => {
	it("replaces hyphens with underscores in server mode (existing behavior)", () => {
		expect(getServerPrefix("foo-bar", "server")).toBe("foo_bar")
	})

	it("strips the -mcp suffix in short mode (existing behavior)", () => {
		expect(getServerPrefix("github-mcp", "short")).toBe("github")
		expect(getServerPrefix("mcp", "short")).toBe("mcp")
	})

	it("returns empty strings unchanged", () => {
		expect(getServerPrefix("", "server")).toBe("")
		expect(getServerPrefix("anything", "none")).toBe("")
	})

	it("sanitizes spaces and other invalid characters", () => {
		// Regression: server named "Atlassian Rovo" produced tool names rejected
		// by Anthropic (tools.N.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$')
		expect(getServerPrefix("Atlassian Rovo", "server")).toBe("Atlassian_Rovo")
		// Trailing "_" from "!" — valid per the provider pattern
		expect(getServerPrefix("server one!", "short")).toBe("server_one_")
	})

	it("keeps letters and digits case-insensitively without lowercasing", () => {
		expect(getServerPrefix("GrafanaProd01", "server")).toBe("GrafanaProd01")
	})
})

describe("formatToolName", () => {
	it("passes structurally valid names through byte-for-byte", () => {
		expect(formatToolName("getJiraIssue", "atlassian-rovo", "server")).toBe("atlassian_rovo_getJiraIssue")
		expect(formatToolName("query_loki", "grafana_prod_master", "server")).toBe("grafana_prod_master_query_loki")
		expect(formatToolName("raw_name", "server", "none")).toBe("raw_name")
	})

	it("keeps hyphens in the tool name (existing behavior)", () => {
		expect(formatToolName("search-issues", "gh", "server")).toBe("gh_search-issues")
	})

	it("sanitizes invalid characters in the server name and in the tool name", () => {
		// Regression: `mcp {search, server:"Atlassian Rovo"}` injected
		// "Atlassian Rovo_getJiraIssue", killing every subsequent turn
		const name = formatToolName("getJiraIssue", "Atlassian Rovo", "server")
		expect(name).toBe("Atlassian_Rovo_getJiraIssue")
		expect(name).toMatch(PROVIDER_PATTERN)

		expect(formatToolName("get issue", "rovo", "server")).toBe("rovo_get_issue")
		expect(formatToolName("a.b/c", "srv:dev", "server")).toBe("srv_dev_a_b_c")
	})

	it("collapses distinct originals onto one wire name (sanitization is not injective)", () => {
		// "get issue" and "get_issue" both format to "rovo_get_issue" — a
		// wire-name collision that registration layers must detect and skip
		// (see the seenNames guard in direct-tools.ts and the origin check in
		// index.ts' registerAndActivate).
		expect(formatToolName("get issue", "rovo", "server")).toBe("rovo_get_issue")
		expect(formatToolName("get_issue", "rovo", "server")).toBe("rovo_get_issue")
	})

	it("sanitizes the short-mode prefix too", () => {
		const name = formatToolName("list", "Atlassian Rovo-mcp", "short")
		expect(name).toBe("Atlassian_Rovo_list")
		expect(name).toMatch(PROVIDER_PATTERN)
	})

	it("produces valid names for arbitrary nasty inputs", () => {
		const servers = ["Atlassian Rovo", "server/one.two", "名前サーバー", "mcp superset.prod-master", "", "!!!"]
		const tools = ["get issue", "a.b/c", "x", "ünïcode τool", ""]
		for (const s of servers) {
			for (const t of tools) {
				for (const mode of ["server", "none", "short"] as const) {
					expect(formatToolName(t, s, mode)).toMatch(PROVIDER_PATTERN)
				}
			}
		}
	})

	it("never returns an empty name for an empty tool name", () => {
		expect(formatToolName("", "gh", "server")).toBe("gh_tool")
		expect(formatToolName("", "gh", "none")).toBe("tool")
	})

	it("truncates names beyond the provider limit, keeping the tool tail", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const tail = "t".repeat(30)
		const name = formatToolName(tail, "a".repeat(120), "server")
		expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH)
		expect(name.endsWith(tail)).toBe(true)
		expect(name).toMatch(PROVIDER_PATTERN)
		warn.mockRestore()
	})

	it("truncates a tool name that alone exceeds the limit", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const name = formatToolName("b".repeat(200), "s", "server")
		expect(name.length).toBe(MAX_TOOL_NAME_LENGTH)
		warn.mockRestore()
	})

	it("warns once per overlong name, not on every call", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		formatToolName("t".repeat(30), "w".repeat(120), "server")
		formatToolName("t".repeat(30), "w".repeat(120), "server")
		expect(warn).toHaveBeenCalledTimes(1)
		// A DIFFERENT overlong original that truncates to the SAME limited result:
		// the warn-once cache is keyed on the original name (not the truncated
		// result), so this one warns again — two distinct tools colliding onto
		// one wire name each deserve a warning.
		formatToolName("t".repeat(30), "w".repeat(121), "server")
		expect(warn).toHaveBeenCalledTimes(2)
		warn.mockRestore()
	})
})

describe("isToolExcluded", () => {
	it("matches the raw tool name and the prefixed variants", () => {
		expect(isToolExcluded("getJiraIssue", "atlassian", "server", ["getJiraIssue"])).toBe(true)
		expect(isToolExcluded("getJiraIssue", "atlassian", "server", ["atlassian_getJiraIssue"])).toBe(true)
		expect(isToolExcluded("getJiraIssue", "atlassian", "server", ["unrelated"])).toBe(false)
	})

	it("normalizes hyphens as before", () => {
		expect(isToolExcluded("search-issues", "gh", "server", ["gh_search_issues"])).toBe(true)
	})

	it("matches excludes written with the unsanitized name (as seen in error messages)", () => {
		// Users may paste "Atlassian Rovo_getJiraIssue" from provider error output or
		// write server names with spaces in their exclusion list.
		expect(isToolExcluded("getJiraIssue", "Atlassian Rovo", "server", ["Atlassian Rovo_getJiraIssue"])).toBe(true)
		expect(isToolExcluded("getJiraIssue", "Atlassian Rovo", "server", ["Atlassian_Rovo_getJiraIssue"])).toBe(true)
	})

	it("ignores non-string entries", () => {
		expect(isToolExcluded("getJiraIssue", "atlassian", "server", [42, null, undefined])).toBe(false)
	})

	it("handles empty/missing exclusion lists", () => {
		expect(isToolExcluded("getJiraIssue", "atlassian", "server", [])).toBe(false)
		expect(isToolExcluded("getJiraIssue", "atlassian", "server", undefined)).toBe(false)
	})
})
