import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { Ferment, Phase } from "../../ferment/types.js"
import { FERMENT_TOOLS, FERMENT_TOOL_NAMES } from "./tool-names.js"
import {
	IMPLEMENTATION_TOOL_NAMES,
	PLANNING_TOOL_NAMES,
	applyFermentToolProfile,
	profileForFerment,
} from "./tool-scope.js"

function createPi(initialActive: string[], allTools: string[]) {
	let active = [...initialActive]
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

function buildFerment(phaseStatus: Phase["status"] | undefined): Ferment {
	// Helper: builds a minimal Ferment with the given phase status (or no phases).
	const phases: Phase[] = phaseStatus
		? [{ id: "phase-1", index: 1, name: "Build", goal: "Implement feature", status: phaseStatus, steps: [] }]
		: []
	return {
		id: "ferment-1",
		name: "Test Ferment",
		status: "running",
		worktree: { path: "/tmp" },
		scoping: {},
		phases,
		decisions: [],
		memories: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}
}

describe("profileForFerment", () => {
	it("returns idle when ferment is undefined", () => {
		expect(profileForFerment(undefined)).toBe("idle")
	})

	it("returns planning when ferment has no phases (defensive against missing phases)", () => {
		expect(profileForFerment(buildFerment(undefined))).toBe("planning")
	})

	it("returns planning when all phases are still planned", () => {
		expect(profileForFerment(buildFerment("planned"))).toBe("planning")
	})

	it("returns implementation when any phase has been activated", () => {
		expect(profileForFerment(buildFerment("active"))).toBe("implementation")
	})

	it("returns implementation when a phase has been completed", () => {
		// Ferment freezes at implementation once any phase was activated, even if all phases are now complete.
		expect(profileForFerment(buildFerment("completed"))).toBe("implementation")
	})

	it("returns implementation when a phase has failed", () => {
		expect(profileForFerment(buildFerment("failed"))).toBe("implementation")
	})

	it("returns implementation when a phase has been skipped", () => {
		expect(profileForFerment(buildFerment("skipped"))).toBe("implementation")
	})
})

describe("planning profile", () => {
	it("when allTools contains only planning tools, result is the registered subset", () => {
		const planningTools = [...PLANNING_TOOL_NAMES]
		const pi = createPi([], planningTools)

		applyFermentToolProfile(pi, "planning")

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).toEqual(planningTools)
	})

	it("when allTools contains extra non-planning tools, they are excluded (intersection)", () => {
		const allTools = [
			"read",
			"grep",
			"find",
			"ls",
			"web_fetch",
			"web_search",
			"set_phase",
			"propose_ferment_scoping",
			"scope_ferment",
			"update_ferment_scope_field",
			"confirm_ferment_completion_criteria",
			"list_ferments",
			"ask_user",
			"activate_ferment_phase",
			"bash",
			"edit",
			"write",
			"Agent",
		]
		const pi = createPi([], allTools)

		applyFermentToolProfile(pi, "planning")

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).not.toContain("bash")
		expect(lastCall).not.toContain("edit")
		expect(lastCall).not.toContain("write")
		expect(lastCall).not.toContain("Agent")
		for (const name of PLANNING_TOOL_NAMES) {
			expect(lastCall).toContain(name)
		}
	})

	it("when allTools returns ZERO ferment tools, result is empty (defensive)", () => {
		const pi = createPi([], ["bash", "edit"])

		applyFermentToolProfile(pi, "planning")

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).toEqual([])
	})

	// Regression: activate_ferment_phase is the transition trigger from planning
	// to implementation. The prompt explicitly tells the planner to call it as
	// the first lifecycle action, so it MUST be in the planning toolset or the
	// transition is unreachable from the planning profile.
	it("includes activate_ferment_phase so the planner can fire the planning → implementation transition", () => {
		const pi = createPi([], ["activate_ferment_phase", "scope_ferment"])

		applyFermentToolProfile(pi, "planning")

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).toContain("activate_ferment_phase")
	})
})

describe("implementation profile", () => {
	it("when allTools contains full standard toolset plus ferment tools, result contains ALL of them", () => {
		const allTools = [
			"read",
			"grep",
			"find",
			"ls",
			"web_fetch",
			"web_search",
			"bash",
			"edit",
			"write",
			"Agent",
			"get_subagent_result",
			"set_phase",
			...FERMENT_TOOL_NAMES,
		]
		const pi = createPi([], allTools)

		applyFermentToolProfile(pi, "implementation")

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).toContain("bash")
		expect(lastCall).toContain("edit")
		expect(lastCall).toContain("write")
		expect(lastCall).toContain("Agent")
		expect(lastCall).toContain("get_subagent_result")
		expect(lastCall).toContain("activate_ferment_phase")
		expect(lastCall).toContain("refine_ferment_phase")
		expect(lastCall).toContain("start_ferment_step")
		expect(lastCall).toContain("complete_ferment_step")
		expect(lastCall).toContain("verify_ferment_step")
		expect(lastCall).toContain("complete_ferment")
		for (const name of FERMENT_TOOL_NAMES) {
			expect(lastCall).toContain(name)
		}
	})

	it("when allTools is missing some required tools, result STILL includes them (defensive union)", () => {
		// Simulate a case where bash is not registered in pi, but implementation profile adds it.
		const pi = createPi([], ["read", "grep"])

		applyFermentToolProfile(pi, "implementation")

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).toContain("bash")
		expect(lastCall).toContain("edit")
		expect(lastCall).toContain("write")
		expect(lastCall).toContain("Agent")
	})
})

describe("worker profile", () => {
	it("applies empty toolset for workers (managed by agents manager, not ferment)", () => {
		const pi = createPi(["read", "bash", "start_ferment_step"], ["read", "bash", "start_ferment_step"])

		applyFermentToolProfile(pi, "worker")

		expect(pi.setActiveTools).toHaveBeenLastCalledWith([])
	})
})

describe("idle profile", () => {
	it("includes non-ferment tools and discovery tools but strips ferment-only tools", () => {
		// Idle = normal chat or post-ferment. Non-ferment tools (read, bash, etc.)
		// and discovery tools (list_ferments, request_ferment_workflow) stay.
		// Ferment-only lifecycle/planning tools are hidden.
		const allTools = [
			"read",
			"bash",
			"list_ferments",
			"request_ferment_workflow",
			"propose_ferment_scoping", // ferment-only: should be hidden
			"start_ferment_step", // ferment-only: should be hidden
			"activate_ferment_phase", // ferment-only: should be hidden
		]
		const pi = createPi([], allTools)

		applyFermentToolProfile(pi, "idle")

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).toContain("read")
		expect(lastCall).toContain("bash")
		expect(lastCall).toContain("list_ferments")
		expect(lastCall).toContain("request_ferment_workflow")
		expect(lastCall).not.toContain("propose_ferment_scoping")
		expect(lastCall).not.toContain("start_ferment_step")
		expect(lastCall).not.toContain("activate_ferment_phase")
	})
})

describe("planning → implementation transition", () => {
	it("profileForFerment returns planning when all phases are planned", () => {
		const ferment = buildFerment("planned")
		expect(profileForFerment(ferment)).toBe("planning")
	})

	it("profileForFerment returns implementation after activate_ferment_phase transitions phase to active", () => {
		// Simulate the result of activate_ferment_phase returning success.
		const ferment = buildFerment("active")
		expect(profileForFerment(ferment)).toBe("implementation")
	})

	it("scope_ferment returning success does NOT change the profile (phase status stays planned)", () => {
		// scope_ferment populates the phases but does not activate them.
		const ferment = buildFerment("planned")
		// The profile remains planning because the phase is still "planned".
		expect(profileForFerment(ferment)).toBe("planning")
		// After activate_ferment_phase succeeds, the phase becomes "active" and profile becomes implementation.
		const activatedFerment = buildFerment("active")
		expect(profileForFerment(activatedFerment)).toBe("implementation")
	})
})

describe("normal vs one-shot parity", () => {
	it("profileForFerment returns planning for both normal and one-shot when phases are planned", () => {
		// Both normal interactive mode and one-shot mode use the same profile model.
		const ferment = buildFerment("planned")
		expect(profileForFerment(ferment)).toBe("planning")
	})

	it("profileForFerment returns implementation for both normal and one-shot when a phase is active", () => {
		// The difference between normal and one-shot is the continuation policy (auto vs manual),
		// NOT the toolset.
		const ferment = buildFerment("active")
		expect(profileForFerment(ferment)).toBe("implementation")
	})
})
