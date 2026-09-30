import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent"
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import {
	buildMcpStartupIssuesSummary,
	MCP_STARTUP_ISSUES_CUSTOM_TYPE,
	type McpStartupIssuesDetails,
	mcpStartupIssuesRenderer,
} from "./startup-issues.js"

type StartupIssuesMessage = Parameters<MessageRenderer<McpStartupIssuesDetails>>[0]

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme

function message(details: McpStartupIssuesDetails | undefined): StartupIssuesMessage {
	return {
		role: "custom",
		customType: MCP_STARTUP_ISSUES_CUSTOM_TYPE,
		content: "",
		display: true,
		details,
		timestamp: 0,
	}
}

function leftClick(): TuiMouseEvent {
	return { type: "click", button: "left", x: 0, y: 0 } as TuiMouseEvent
}

describe("buildMcpStartupIssuesSummary", () => {
	it("pluralizes the issue count", () => {
		expect(buildMcpStartupIssuesSummary(["one"])).toBe("[1 MCP issue] Some MCP configuration needs attention.")
		expect(buildMcpStartupIssuesSummary(["one", "two"])).toBe("[2 MCP issues] Some MCP configuration needs attention.")
	})
})

describe("mcpStartupIssuesRenderer", () => {
	it("returns undefined when there is nothing to show", () => {
		expect(mcpStartupIssuesRenderer(message(undefined), { expanded: false, outputPad: 1 }, theme)).toBeUndefined()
		expect(
			mcpStartupIssuesRenderer(message({ warnings: [] }), { expanded: false, outputPad: 1 }, theme),
		).toBeUndefined()
	})

	it("renders collapsed by default: one summary line with a ctrl+o hint, no issue details", () => {
		const component = mcpStartupIssuesRenderer(
			message({ warnings: ["server x failed to start", "config key y is unknown"] }),
			{ expanded: false, outputPad: 1 },
			theme,
		)

		const lines = component?.render(100) ?? []
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain("[2 MCP issues] Some MCP configuration needs attention.")
		expect(lines[0]).toContain("(ctrl+o to expand)")
		expect(lines[0]).not.toContain("server x failed to start")
	})

	it("renders the full issue list when expanded", () => {
		const component = mcpStartupIssuesRenderer(
			message({ warnings: ["server x failed to start", "config key y is unknown"] }),
			{ expanded: true, outputPad: 1 },
			theme,
		)

		const lines = component?.render(100) ?? []
		expect(lines).toHaveLength(3)
		expect(lines[0]).toContain("[MCP issues]")
		expect(lines[0]).toContain("(ctrl+o to collapse)")
		expect(lines[1]).toBe("server x failed to start")
		expect(lines[2]).toBe("config key y is unknown")
	})

	it("splits multi-line warnings into separate rows", () => {
		const component = mcpStartupIssuesRenderer(
			message({ warnings: ["first line\nsecond line"] }),
			{ expanded: true, outputPad: 1 },
			theme,
		)

		expect(component?.render(100)).toEqual([expect.stringContaining("[MCP issues]"), "first line", "second line"])
	})

	it("right-aligns the hint and truncates the summary on narrow terminals", () => {
		const component = mcpStartupIssuesRenderer(
			message({ warnings: ["one", "two"] }),
			{ expanded: false, outputPad: 1 },
			theme,
		)

		const lines = component?.render(30) ?? []
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain("(ctrl+o to expand)")
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(30)
	})

	it("toggles on left click and ignores other mouse events", () => {
		const component = mcpStartupIssuesRenderer(
			message({ warnings: ["server x failed to start"] }),
			{ expanded: false, outputPad: 1 },
			theme,
		)

		expect(component?.handleMouse?.({ type: "move", button: "none", x: 0, y: 0 } as TuiMouseEvent)).toBeUndefined()
		expect(component?.render(100)).toHaveLength(1)

		expect(component?.handleMouse?.(leftClick())).toEqual({ handled: true })
		expect(component?.render(100)).toEqual([
			expect.stringContaining("(ctrl+o to collapse)"),
			"server x failed to start",
		])

		expect(component?.handleMouse?.(leftClick())).toEqual({ handled: true })
		expect(component?.render(100)).toHaveLength(1)
	})
})
