import { namespaceProxyName } from "pi-mcp-adapter"
import { formatToolName, getServerPrefix, isToolExcluded, MAX_TOOL_NAME_LENGTH } from "pi-mcp-adapter/types"
import { describe, expect, it, vi } from "vitest"

// Provider-side contract (Anthropic custom tools): ^[a-zA-Z0-9_-]{1,128}$
const PROVIDER_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

// Master's fix for #1168 (da328918) is carried into the published adapter by
// the dependency patch (see docs/mcp-adapter-audit.md); namespace proxy names
// are capped natively since 2.34.0 (upstream #529). This file is the complete
// port of the original regression suite — a failure here means the patch
// stopped applying or an adapter upgrade dropped compatibility.
describe("getServerPrefix", () => {
	it("replaces hyphens with underscores in server mode", () => {
		expect(getServerPrefix("foo-bar", "server")).toBe("foo_bar")
	})

	it("strips the -mcp suffix in short mode", () => {
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

	it("keeps hyphens in the tool name", () => {
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
		// wire-name collision the adapter's registration layer skips via its
		// seenNames guard (direct-tools.ts).
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
		// the warn-once cache is keyed on the original name, so this one warns
		// again — two distinct tools colliding onto one wire name each deserve
		// a warning.
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

	it("matches excludes written with fully-raw dotted spellings", () => {
		// Pre-fix wire names kept dots in both the server prefix and the tool
		// name; a user pasting that exact string must still exclude the tool.
		expect(isToolExcluded("a.b", "srv.dev", "server", ["srv.dev_a.b"])).toBe(true)
	})

	it("ignores non-string entries", () => {
		expect(isToolExcluded("getJiraIssue", "atlassian", "server", [42, null, undefined])).toBe(false)
	})

	it("handles empty/missing exclusion lists", () => {
		expect(isToolExcluded("getJiraIssue", "atlassian", "server", [])).toBe(false)
		expect(isToolExcluded("getJiraIssue", "atlassian", "server", undefined)).toBe(false)
	})
})

describe("namespace proxy tool names", () => {
	// namespaceProxyName feeds per-server proxy tools (mcp__<ns>); adapter
	// 2.34.0 hashes and caps it natively (upstream #529). These tests pin the
	// provider contract so a regression — e.g. during an adapter upgrade — is
	// caught here (original bug: a 128-char server name produced a 133-char
	// wire name).
	it("keeps short ASCII servers readable", () => {
		expect(namespaceProxyName("github")).toBe("mcp__github")
	})

	it("caps long server names within the provider limit, deterministically and distinctly", () => {
		const name = namespaceProxyName("a".repeat(128))
		expect(name).toMatch(PROVIDER_PATTERN)
		expect(name.startsWith("mcp__")).toBe(true)
		expect(namespaceProxyName("a".repeat(128))).toBe(name)
		expect(namespaceProxyName(`${"a".repeat(127)}b`)).not.toBe(name)
	})

	it.each(["Atlassian Rovo", "サーバー x/y", "_mcpns_foo"])("produces a provider-safe proxy name for %j", (server) => {
		const name = namespaceProxyName(server)
		expect(name).toMatch(PROVIDER_PATTERN)
		expect(name).toContain("_mcpns_") // exotic names must be encoded, never raw
	})
})
