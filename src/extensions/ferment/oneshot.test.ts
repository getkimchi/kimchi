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
})
