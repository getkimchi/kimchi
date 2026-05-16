import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { applyPlannerOneshotAllowlist, disableFermentTools, enableFermentTools } from "./tool-scope.js"

function createPi(activeTools: string[], allTools: string[]) {
	return {
		getActiveTools: vi.fn(() => activeTools),
		getAllTools: vi.fn(() => allTools.map((name) => ({ name }))),
		setActiveTools: vi.fn(),
	} as unknown as ExtensionAPI
}

describe("ferment tool scope", () => {
	it("removes ferment tools from the active set", () => {
		const pi = createPi(
			["read", "create_ferment", "bash", "start_ferment_step"],
			["read", "bash", "create_ferment", "start_ferment_step"],
		)

		disableFermentTools(pi)

		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash"])
	})

	it("enables registered ferment tools without duplicating active tools", () => {
		const pi = createPi(["read", "create_ferment", "bash"], ["read", "bash", "create_ferment", "start_ferment_step"])

		enableFermentTools(pi)

		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "create_ferment", "start_ferment_step"])
	})
})

describe("applyPlannerOneshotAllowlist", () => {
	it("strips inline implementation tools, keeping ferment lifecycle + Agent + read", () => {
		const allTools = [
			"bash",
			"edit",
			"write",
			"python-edit",
			"web_search",
			"web_fetch",
			"grep",
			"ls",
			"read",
			"Agent",
			"get_subagent_result",
			"set_phase",
			"scope_ferment",
			"activate_ferment_phase",
			"start_ferment_step",
			"complete_ferment_step",
			"complete_ferment",
		]
		const pi = createPi(allTools, allTools)

		applyPlannerOneshotAllowlist(pi)

		expect(pi.setActiveTools).toHaveBeenCalledWith([
			"read",
			"Agent",
			"get_subagent_result",
			"set_phase",
			"scope_ferment",
			"activate_ferment_phase",
			"start_ferment_step",
			"complete_ferment_step",
			"complete_ferment",
		])
	})

	it("only keeps tools that are actually registered", () => {
		const pi = createPi(["read", "bash"], ["read", "bash"])

		applyPlannerOneshotAllowlist(pi)

		expect(pi.setActiveTools).toHaveBeenCalledWith(["read"])
	})
})
