import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { Ferment, Phase } from "../../ferment/types.js"
import type { PendingPlanReview } from "./plan-review.js"
import type { FermentRuntime } from "./runtime.js"
import { FERMENT_TOOL_NAMES } from "./tool-names.js"
import {
	applyFermentRuntimeToolProfile,
	applyFermentToolProfile,
	PLANNING_TOOL_NAMES,
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
	it("when allTools contains only planning tools, result is the registered subset plus shared core (todo tools)", () => {
		// The planning profile derives from the catalog's planning-ferment profile,
		// which includes SHARED_CORE_TOOLS (read tools + todo lifecycle tools) plus
		// the ferment planning tools. We pass only PLANNING_TOOL_NAMES as registered
		// tools; the catalog adds the shared core regardless of registration.
		const planningTools = [...PLANNING_TOOL_NAMES]
		const pi = createPi([], planningTools)

		applyFermentToolProfile(pi, "planning")

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		// All registered planning tools must be present
		for (const name of planningTools) {
			expect(lastCall).toContain(name)
		}
		// Todo lifecycle tools are shared core — always present
		expect(lastCall).toContain("create_todos")
		expect(lastCall).toContain("update_todos")
		expect(lastCall).toContain("add_todo")
		expect(lastCall).toContain("mark_todo")
		expect(lastCall).toContain("clear_todos")
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
		expect(lastCall).toContain("list_ferments")
		expect(lastCall).toContain("edit")
		expect(lastCall).toContain("write")
		// Ferment-only planner tools stripped
		expect(lastCall).not.toContain("propose_ferment_scoping")
		expect(lastCall).not.toContain("start_ferment_step")
		expect(lastCall).not.toContain("activate_ferment_phase")
	})
})

// ─── applyFermentRuntimeToolProfile: pending plan review suppression ───────
// When `propose_ferment_scoping` returns "Plan ready for review" a pending
// plan review is set. To force the turn to end (so `agent_end` fires and the
// review dialog appears), ALL tools are suppressed via `pi.setActiveTools([])`.
// Once the review is confirmed or cancelled, the caller clears the pending
// review and re-applies the normal profile.

function createMinimalRuntime(
	activeFerment: Ferment | undefined,
	pendingReview: PendingPlanReview | undefined,
): FermentRuntime {
	return {
		getActiveId: vi.fn(() => activeFerment?.id),
		getActive: vi.fn(() => activeFerment),
		getPendingPlanReview: vi.fn(() => pendingReview),
	} as unknown as FermentRuntime
}

const draftFerment: Ferment = {
	id: "ferment-draft",
	name: "Draft Ferment",
	status: "running",
	worktree: { path: "/tmp" },
	scoping: {},
	phases: [],
	decisions: [],
	memories: [],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
}

const sampleReview: PendingPlanReview = {
	fermentId: "ferment-draft",
	planMarkdown: "# Plan",
}

describe("applyFermentRuntimeToolProfile: pending plan review suppression", () => {
	it("suppresses all tools (setActiveTools([])) when a pending plan review exists", () => {
		// After propose_ferment_scoping returns "Plan ready for review", the
		// pending review is set. The model must have NO tools so its next LLM
		// call is text-only (stopReason: "stop"), ending the turn and firing
		// agent_end which triggers the review dialog.
		const pi = createPi(["read", "bash"], ["read", "bash", "edit", "propose_ferment_scoping"])
		const runtime = createMinimalRuntime(draftFerment, sampleReview)

		applyFermentRuntimeToolProfile(pi, runtime)

		expect(pi.setActiveTools).toHaveBeenLastCalledWith([])
	})

	it("restores the planning profile after the pending review is cleared (confirm/cancel)", () => {
		// After confirmPendingScope or review cancellation, the caller clears
		// the pending review. The ferment is still in draft (planning) phase,
		// so the planning-ferment profile is re-applied.
		const pi = createPi(["read"], ["read", "grep", "propose_ferment_scoping"])
		const runtime = createMinimalRuntime(draftFerment, undefined) // review cleared

		applyFermentRuntimeToolProfile(pi, runtime)

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		// Planning tools are restored (not empty)
		expect(lastCall).toContain("read")
		expect(lastCall).toContain("propose_ferment_scoping")
		// Execution tools are NOT present in planning profile
		expect(lastCall).not.toContain("bash")
	})

	it("restores the implementation profile when an activated ferment has no pending review", () => {
		// If a phase was activated (implementation) and the review is cleared,
		// the implementation profile is restored with execution tools.
		const implFerment: Ferment = {
			...draftFerment,
			phases: [{ id: "phase-1", index: 1, name: "Build", goal: "Build it", status: "active", steps: [] }],
		}
		const pi = createPi(["read"], ["read", "bash", "edit", "write", "Agent", ...PLANNING_TOOL_NAMES])
		const runtime = createMinimalRuntime(implFerment, undefined)

		applyFermentRuntimeToolProfile(pi, runtime)

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).toContain("bash")
		expect(lastCall).toContain("edit")
		expect(lastCall).toContain("Agent")
	})

	it("does NOT suppress tools when no pending review exists (no regression)", () => {
		// Normal planning flow: no pending review. The profile is applied as
		// before — planning tools are available, execution tools are not.
		const pi = createPi(["read"], [...PLANNING_TOOL_NAMES, "bash", "edit"])
		const runtime = createMinimalRuntime(draftFerment, undefined)

		applyFermentRuntimeToolProfile(pi, runtime)

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).not.toEqual([])
		expect(lastCall).toContain("read")
		expect(lastCall).toContain("propose_ferment_scoping")
		expect(lastCall).not.toContain("bash")
	})

	it("does NOT suppress tools when no active ferment exists", () => {
		// Idle: no active ferment. No pending review possible.
		const pi = createPi(["read", "bash"], ["read", "bash", "edit"])
		const runtime = createMinimalRuntime(undefined, undefined)

		applyFermentRuntimeToolProfile(pi, runtime)

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).not.toEqual([])
	})
})
