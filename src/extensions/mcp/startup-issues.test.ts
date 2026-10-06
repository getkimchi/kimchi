import { describe, expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import {
	buildMcpStartupIssuesSummary,
	MCP_STARTUP_ISSUES_MESSAGE_TYPE,
	showMcpStartupIssues,
} from "./startup-issues.js"

describe("buildMcpStartupIssuesSummary", () => {
	it("pluralizes the issue count", () => {
		expect(buildMcpStartupIssuesSummary(["one"])).toBe("[1 MCP issue] Some MCP configuration needs attention.")
		expect(buildMcpStartupIssuesSummary(["one", "two"])).toBe("[2 MCP issues] Some MCP configuration needs attention.")
	})
})

describe("showMcpStartupIssues", () => {
	it("sends one display-only transcript message with the full issue list in details", () => {
		const harness = createExtensionApi()

		showMcpStartupIssues(harness.api, ["server x failed to start", "config key y is unknown"])

		expect(harness.sendMessage).toHaveBeenCalledWith(
			{
				customType: MCP_STARTUP_ISSUES_MESSAGE_TYPE,
				// The LLM context only ever sees this one-line annotation; the
				// issue list lives in details above it, never in token content.
				content: [{ type: "text", text: "<system-annotation>MCP startup issues (2)</system-annotation>" }],
				display: true,
				details: {
					summary: "[2 MCP issues] Some MCP configuration needs attention.",
					title: "[MCP issues]",
					entries: ["server x failed to start", "config key y is unknown"],
				},
			},
			{ triggerTurn: false },
		)
	})

	it("sends nothing when there are no issues", () => {
		const harness = createExtensionApi()

		showMcpStartupIssues(harness.api, [])

		expect(harness.sendMessage).not.toHaveBeenCalled()
	})
})
