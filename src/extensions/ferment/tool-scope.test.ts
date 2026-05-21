import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import {
	FERMENT_TOOL_NAMES,
	applyFermentToolProfile,
	applyPlannerOneshotAllowlist,
	profileForFerment,
} from "./tool-scope.js"

function createPi(activeTools: string[], allTools: string[]) {
	let active = [...activeTools]
	const pi = {
		getActiveTools: vi.fn(() => active),
		getAllTools: vi.fn(() => allTools.map((name) => ({ name }))),
		setActiveTools: vi.fn((names: string[]) => {
			active = names
		}),
		on: vi.fn(),
	} as unknown as ExtensionAPI
	return pi
}

describe("ferment tool scope", () => {
	it("applies the worker profile by removing ferment tools from the active set", () => {
		const pi = createPi(["read", "bash", "start_ferment_step"], ["read", "bash", "start_ferment_step"])

		applyFermentToolProfile(pi, "worker")

		expect(pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"])
	})

	it("applies the planner-active profile", () => {
		const pi = createPi(["read", "bash"], ["read", "bash", "start_ferment_step"])

		applyFermentToolProfile(pi, "planner-active")

		expect(pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "start_ferment_step"])
	})

	it("applies the idle profile as discovery-only ferment tools", () => {
		const pi = createPi(
			["read", "bash", "scope_ferment", "activate_ferment_phase", "list_ferments"],
			["read", "bash", "scope_ferment", "activate_ferment_phase", "list_ferments"],
		)

		applyFermentToolProfile(pi, "idle")

		expect(pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "list_ferments"])
	})

	it("keeps the existing-ferment lifecycle surface for an active planner profile", () => {
		const allTools = ["read", "bash", ...FERMENT_TOOL_NAMES]
		const pi = createPi(["read", "bash"], allTools)

		applyFermentToolProfile(pi, "planner-active")

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		for (const name of FERMENT_TOOL_NAMES) {
			expect(lastCall).toContain(name)
		}
		expect(lastCall).not.toContain("set_ferment_mode")
	})

	it("keeps only non-mutating ferment discovery while paused or terminal", () => {
		const pi = createPi(
			["read", "bash", "list_ferments", "complete_ferment"],
			["read", "bash", "list_ferments", "complete_ferment"],
		)

		applyFermentToolProfile(pi, "paused-terminal")

		expect(pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "list_ferments"])
	})

	it("selects session profiles from ferment role and status", () => {
		expect(profileForFerment(undefined)).toBe("idle")
		expect(profileForFerment({ status: "draft" } as never)).toBe("planner-active")
		expect(profileForFerment({ status: "planned" } as never)).toBe("planner-active")
		expect(profileForFerment({ status: "running" } as never)).toBe("planner-active")
		expect(profileForFerment({ status: "paused" } as never)).toBe("paused-terminal")
		expect(profileForFerment({ status: "complete" } as never)).toBe("paused-terminal")
		expect(profileForFerment({ status: "abandoned" } as never)).toBe("paused-terminal")
	})
})

describe("applyPlannerOneshotAllowlist", () => {
	it("strips inline implementation tools, keeping orchestration tools", () => {
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

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(pi.setActiveTools).toHaveBeenLastCalledWith([
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

		expect(pi.setActiveTools).toHaveBeenLastCalledWith(["read"])
	})

	it("oneshot planner profile includes registered existing-ferment lifecycle tools", () => {
		const allTools = ["bash", "edit", "read", "Agent", "get_subagent_result", "set_phase", ...FERMENT_TOOL_NAMES]
		const pi = createPi(allTools, allTools)

		applyFermentToolProfile(pi, "oneshot-planner")

		expect(pi.setActiveTools).toHaveBeenCalledTimes(1)
		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).not.toContain("bash")
		expect(lastCall).not.toContain("edit")
		for (const name of FERMENT_TOOL_NAMES) {
			expect(lastCall).toContain(name)
		}
	})
})

describe("pi-mono run snapshot regression", () => {
	it("requires lifecycle tools in the initial run snapshot", () => {
		const initialRunSnapshot = new Set(["scope_ferment"])
		const callFromSnapshot = (toolName: string) =>
			initialRunSnapshot.has(toolName) ? `called ${toolName}` : `Tool ${toolName} not found`
		const pi = createPi(["scope_ferment"], ["scope_ferment", "activate_ferment_phase"])

		applyFermentToolProfile(pi, "planner-active")

		expect((pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0]).toContain("activate_ferment_phase")
		expect(callFromSnapshot("activate_ferment_phase")).toBe("Tool activate_ferment_phase not found")
	})
})
