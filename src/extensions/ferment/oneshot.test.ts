import { describe, expect, it } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { buildOneshotNudge } from "./oneshot.js"

const NOW = "2026-01-01T00:00:00.000Z"

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "019ed36a-f5f9-71dc-bc9e-4d27d1880b25",
		name: "Tune MuJoCo model",
		status: "draft",
		worktree: { path: "/repo" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	}
}

const INTENT = "Tune /app/model_ref.xml so simulation finishes in 60% of the original time."

describe("buildOneshotNudge", () => {
	it("instructs the planner to call scope_ferment", () => {
		const out = buildOneshotNudge(makeFerment(), INTENT)
		expect(out).toContain("Call scope_ferment")
	})

	it("lists the scope_ferment parameters required by ScopeParams", () => {
		const out = buildOneshotNudge(makeFerment(), INTENT)
		expect(out).toContain("ferment_id")
		expect(out).toContain("title")
		expect(out).toContain("goal")
		expect(out).toContain("success_criteria")
		expect(out).toContain("phases")
	})

	// Regression: gates was originally omitted, causing validateGatesOrErr to reject the call.
	it("explicitly lists the gates array with P1, P2, P3 plan-scope gate ids", () => {
		const out = buildOneshotNudge(makeFerment(), INTENT)
		expect(out).toMatch(/gates\s*:/i)
		expect(out).toContain("P1")
		expect(out).toContain("P2")
		expect(out).toContain("P3")
		expect(out).toMatch(/schema\s+(rejects|requires|hard-?rejects)/i)
	})

	it("tells the model not to ask the user for confirmation", () => {
		const out = buildOneshotNudge(makeFerment(), INTENT)
		expect(out).toMatch(/do NOT ask for confirmation/i)
	})

	it("does NOT suggest propose_ferment_scoping in the user message", () => {
		const out = buildOneshotNudge(makeFerment(), INTENT)
		expect(out).not.toContain("propose_ferment_scoping")
	})

	// Step 5 of the unify-ferment-tool-modes ferment: the one-shot envelope
	// describes the lifecycle-driven toolset transition (planning phase →
	// implementation toolset unlocks on activate_ferment_phase) rather than
	// the static curated allowlist from the pre-unified model.
	it("envelope describes the lifecycle-driven toolset transition", () => {
		const out = buildOneshotNudge(makeFerment(), INTENT)
		// Must describe both phases of the toolset.
		expect(out).toContain("planning phase")
		expect(out).toContain("implementation toolset unlocks")
		// Must reference the activation trigger.
		expect(out).toContain("activate_ferment_phase")
		// Must NOT contain the old static curated allowlist phrasing.
		// The old phrasing had quoted tool names like "Agent", "get_subagent_result", "read".
		expect(out).not.toContain('"Agent"')
		expect(out).not.toContain('"get_subagent_result"')
		expect(out).not.toContain('"read"')
	})
})
