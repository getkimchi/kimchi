import { describe, expect, it, vi } from "vitest"
import { createContext, mountWidget } from "../__mocks__/context.js"
import { buildMcpStartupIssuesSummary, MCP_STARTUP_ISSUES_WIDGET_KEY, showMcpStartupIssues } from "./startup-issues.js"

describe("buildMcpStartupIssuesSummary", () => {
	it("pluralizes the issue count", () => {
		expect(buildMcpStartupIssuesSummary(["one"])).toBe("[1 MCP issue] Some MCP configuration needs attention.")
		expect(buildMcpStartupIssuesSummary(["one", "two"])).toBe("[2 MCP issues] Some MCP configuration needs attention.")
	})
})

describe("showMcpStartupIssues", () => {
	it("mounts a collapsed notice widget that expands to the full issue list", () => {
		const ctx = createContext()
		showMcpStartupIssues(ctx, ["server x failed to start", "config key y is unknown"])

		const component = mountWidget(ctx, MCP_STARTUP_ISSUES_WIDGET_KEY)
		const collapsed = component?.render(100) ?? []
		expect(collapsed).toHaveLength(1)
		expect(collapsed[0]).toContain("[2 MCP issues] Some MCP configuration needs attention.")
		expect(collapsed[0]).toContain("(ctrl+o to expand)")

		vi.mocked(ctx.ui.getToolsExpanded).mockReturnValue(true)
		expect(component?.render(100)).toEqual([
			expect.stringContaining("[MCP issues]"),
			"server x failed to start",
			"config key y is unknown",
		])
	})

	it("clears the widget when there are no issues", () => {
		const ctx = createContext()
		showMcpStartupIssues(ctx, [])

		expect(ctx.ui.setWidget).toHaveBeenCalledWith(MCP_STARTUP_ISSUES_WIDGET_KEY, undefined)
		expect(mountWidget(ctx, MCP_STARTUP_ISSUES_WIDGET_KEY)).toBeUndefined()
	})
})
