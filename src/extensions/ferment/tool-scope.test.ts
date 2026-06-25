import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { Ferment, Phase } from "../../ferment/types.js"
import { createToolVisibility } from "../prompt-construction/tool-visibility.js"
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

	it("when allTools contains only non-ferment tools, catalog planning tools are still applied", () => {
		// The catalog is authoritative: planning-ferment always returns the catalog's
		// tool list, independent of what allTools reports. This replaces the old
		// defensive "return empty when intersection is empty" behavior.
		const pi = createPi([], ["bash", "edit"])

		applyFermentToolProfile(pi, "planning")

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		// Catalog planning-ferment includes core tools.
		expect(lastCall).toContain("read")
		expect(lastCall).toContain("list_ferments")
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
	it("restores the user's full base toolset minus ferment-only tools", () => {
		// The idle profile is a special case: rather than returning the catalog's
		// fixed SHARED_CORE_TOOLS list, it derives from the registered toolset so
		// users keep access to bash, edit, write, third-party tools, etc. when
		// they exit a ferment back to normal chat. Only ferment-only tools are
		// filtered out. See PR #683 review feedback for the rationale.
		const allTools = [
			"read",
			"bash",
			"edit",
			"write",
			"list_ferments", // ferment-mode but not planner-only; remains visible
			"propose_ferment_scoping", // ferment-only: filtered out
			"start_ferment_step", // ferment-only: filtered out
			"activate_ferment_phase", // ferment-only: filtered out
		]
		const pi = createPi([], allTools)

		applyFermentToolProfile(pi, "idle")

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		// Base toolset preserved
		expect(lastCall).toContain("read")
		expect(lastCall).toContain("bash")
		expect(lastCall).toContain("edit")
		expect(lastCall).toContain("write")
		// Ferment-only planner tools stripped
		expect(lastCall).not.toContain("propose_ferment_scoping")
		expect(lastCall).not.toContain("start_ferment_step")
		expect(lastCall).not.toContain("activate_ferment_phase")
	})
})
