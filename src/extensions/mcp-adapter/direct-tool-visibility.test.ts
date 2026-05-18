import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createDirectToolVisibility } from "./direct-tool-visibility.js"

function makePi(toolNames: string[]): ExtensionAPI & { active: string[] } {
	const tools = toolNames.map((name) => ({ name }) as ToolInfo)
	const state = {
		active: [...toolNames],
		on: vi.fn(),
		getAllTools: vi.fn(() => tools),
		getActiveTools: vi.fn(() => state.active),
		setActiveTools: vi.fn((names: string[]) => {
			state.active = names
		}),
	}
	return state as unknown as ExtensionAPI & { active: string[] }
}

describe("direct MCP tool visibility", () => {
	it("hides dynamic tools on input and re-exposes already registered dynamic tools", () => {
		const pi = makePi(["jira_search"])
		const controller = createDirectToolVisibility(pi)
		const dynamicToolNames = new Set(["jira_search"])

		controller.hideDynamic(dynamicToolNames)
		expect(pi.active).toEqual([])
		expect(dynamicToolNames.size).toBe(0)

		controller.expose(["jira_search"], { markDynamic: true, dynamicToolNames })
		expect(pi.active).toEqual(["jira_search"])
		expect([...dynamicToolNames]).toEqual(["jira_search"])
	})

	it("does not treat permanent tools as transient when discovered through search", () => {
		const pi = makePi(["jira_search"])
		const controller = createDirectToolVisibility(pi)
		const dynamicToolNames = new Set<string>()

		controller.markPermanent(["jira_search"], dynamicToolNames)
		controller.expose(["jira_search"], { markDynamic: true, dynamicToolNames })
		controller.hideDynamic(dynamicToolNames)

		expect(pi.active).toEqual(["jira_search"])
		expect(dynamicToolNames.size).toBe(0)
	})

	it("promoting a previously dynamic tool to permanent releases the transient hide", () => {
		const pi = makePi(["jira_search"])
		const controller = createDirectToolVisibility(pi)
		const dynamicToolNames = new Set(["jira_search"])

		controller.hideDynamic(dynamicToolNames)
		expect(pi.active).toEqual([])

		controller.expose(["jira_search"], { markDynamic: false, dynamicToolNames })
		controller.hideDynamic(dynamicToolNames)

		expect(pi.active).toEqual(["jira_search"])
		expect(dynamicToolNames.size).toBe(0)
	})
})
