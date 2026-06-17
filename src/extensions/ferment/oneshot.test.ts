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
		// The model must be told to supply every required field, otherwise the
		// schema's prepareArguments guard throws and the call is lost.
		expect(out).toContain("ferment_id")
		expect(out).toContain("title")
		expect(out).toContain("goal")
		expect(out).toContain("success_criteria")
		expect(out).toContain("phases")
	})

	it("explicitly lists the gates array with P1, P2, P3 plan-scope gate ids", () => {
		// Regression for Bug 1: oneshot.ts:14 originally omitted `gates` from the
		// parameter list, but validateGatesOrErr hard-fails any scope_ferment
		// call without a `gates` array covering P1, P2, P3. The model has no way
		// to recover on its own, so the ferment gets stuck in draft.
		const out = buildOneshotNudge(makeFerment(), INTENT)
		expect(out).toMatch(/gates\s*:/i)
		expect(out).toContain("P1")
		expect(out).toContain("P2")
		expect(out).toContain("P3")
		// The reminder must spell out the schema-rejection risk so the model
		// emits gates on the first try instead of burning a retry.
		expect(out).toMatch(/schema\s+(rejects|requires|hard-?rejects)/i)
	})

	it("tells the model not to ask the user for confirmation", () => {
		const out = buildOneshotNudge(makeFerment(), INTENT)
		expect(out).toMatch(/do NOT ask for confirmation/i)
	})

	it("names the existing ferment by id in the envelope", () => {
		const out = buildOneshotNudge(makeFerment({ id: "abc-123" }), INTENT)
		expect(out).toContain('"abc-123"')
		expect(out).toContain('"Tune MuJoCo model"')
	})

	it("embeds the user intent verbatim", () => {
		const out = buildOneshotNudge(makeFerment(), INTENT)
		expect(out).toContain(INTENT)
	})

	it("does NOT suggest propose_ferment_scoping in the user message", () => {
		// The user message is the bootstrapping nudge; it should pick ONE tool
		// for the model to call. In one-shot mode scope_ferment is the correct
		// tool — proposing would route through the interactive gate which
		// is never armed here.
		const out = buildOneshotNudge(makeFerment(), INTENT)
		expect(out).not.toContain("propose_ferment_scoping")
	})
})
