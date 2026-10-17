/**
 * Contract test for the MCP project-config-location hunks in
 * `patches/@earendil-works__pi-coding-agent@1.3.0.patch`: pi 1.3.0's native
 * built-in MCP discovers the project layer at `<cwd>/.pi/mcp.json` (via
 * CONFIG_DIR_NAME). Kimchi's project MCP configs live at `.kimchi/mcp.json`
 * (the `piConfig.mcpProjectConfigDir = ".kimchi"` layer that the old
 * pi-mcp-adapter patch honored). The patch repoints native discovery
 * (config.js), the CLI hint (cli.js), and the /mcp UI empty-state/status
 * strings (index.js) at `.kimchi/mcp.json` so existing user configs keep
 * loading after the adapter is dropped.
 *
 * Trust gating is unchanged: `.kimchi/mcp.json` is already in the patched
 * `KIMCHI_TRUST_REQUIRING_PROJECT_RESOURCES` list (dist/core/trust-manager.js),
 * so an untrusted project's MCP config stays unread, same as before.
 *
 * If this test starts failing after a pin bump, check whether upstream made
 * the project config filename a `piConfig` key (then remove the repoint and
 * set the key) or moved native MCP discovery.
 */
import { readFileSync } from "node:fs"
import ts from "typescript"
import { describe, expect, it } from "vitest"

function dist(rel: string): string {
	return readFileSync(new URL(`../node_modules/@earendil-works/pi-coding-agent/dist/${rel}`, import.meta.url), "utf8")
}

describe("patch: native MCP project config at .kimchi/mcp.json", () => {
	it("config.js stays syntactically valid after the patch is applied", () => {
		// A malformed patch silently breaks every session at import time; text
		// checks alone do not catch a comment that accidentally swallows code.
		const report = ts.transpileModule(dist("extensions/mcp/config.js"), {
			compilerOptions: { allowJs: true },
			reportDiagnostics: true,
		})
		expect((report.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)).toEqual([])
	})

	it("discovers the project layer from .kimchi, not .pi", () => {
		const configJs = dist("extensions/mcp/config.js")
		expect(configJs).toContain('join(options.cwd, ".kimchi", "mcp.json")')
		expect(configJs).not.toContain('CONFIG_DIR_NAME, "mcp.json")')
	})

	it("mentions .kimchi/mcp.json in config-discovery docs and never reads .pi/mcp.json", () => {
		const configJs = dist("extensions/mcp/config.js")
		expect(configJs).toContain(".kimchi/mcp.json")
		// The only allowed occurrence of .pi/mcp.json is the comment noting what
		// upstream did (marked as the upstream original).
		expect(configJs.match(/\.pi\/mcp\.json/g) ?? []).toHaveLength(1)
		expect(configJs).toContain("upstream `.pi/mcp.json`")
	})

	it("points user-facing hints at .kimchi/mcp.json (CLI list + /mcp UI)", () => {
		expect(dist("extensions/mcp/cli.js")).not.toContain(".pi/mcp.json")
		expect(dist("extensions/mcp/cli.js")).toContain(".kimchi/mcp.json")
		expect(dist("extensions/mcp/index.js")).not.toContain(".pi/mcp.json")
		expect(dist("extensions/mcp/index.js")).toContain(".kimchi/mcp.json")
	})

	it("keeps .kimchi/mcp.json in the trust-gated project resources", () => {
		// Without this, a cloned repo's .kimchi/mcp.json servers would connect
		// without a trust prompt.
		expect(dist("core/trust-manager.js")).toContain('".kimchi/mcp.json"')
	})
})
