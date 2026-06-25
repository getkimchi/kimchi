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

	it("does not tell the model to skip asking questions — ask_user routes to judge automatically", () => {
		const out = buildOneshotNudge(makeFerment(), INTENT)
		// The Interview step must NOT tell the model to skip calling ask_user.
		// Judge routing is transparent; the model calls ask_user as normal.
		// Check the Interview bullet specifically (not the shared process which may
		// mention "Do not ask" in a different context).
		const interviewBullet = out.match(/- \*\*Interview\*\*:.*?(?=\n- \*\*|\n\n)/s)?.[0] ?? ""
		expect(interviewBullet).not.toMatch(/do not ask.*question|skip.*question|no.*interactive user/i)
	})

	it("does not instruct the model to skip confirm_ferment_completion_criteria explicitly", () => {
		const out = buildOneshotNudge(makeFerment(), INTENT)
		// confirm_ferment_completion_criteria is hidden from the toolset in one-shot mode
		// (via the cooperative visibility layer), so the prompt doesn't need to mention it.
		// If it does appear, it should not be telling the model NOT to call it.
		if (out.includes("confirm_ferment_completion_criteria")) {
			expect(out).not.toMatch(/do not call confirm_ferment_completion_criteria/i)
		}
	})

	it("does NOT suggest propose_ferment_scoping in the user message", () => {
		const out = buildOneshotNudge(makeFerment(), INTENT)
		expect(out).not.toContain("propose_ferment_scoping")
	})

	it("includes the full shared planning process from src/shared/planning", () => {
		const out = buildOneshotNudge(makeFerment(), INTENT)
		expect(out).toContain("STEP 1 — ORIENT")
		expect(out).toContain("STEP 2 — INTERVIEW")
		expect(out).toContain("STEP 3 — COMPLETION CRITERIA")
		expect(out).toContain("STEP 4 — DEEP EXPLORATION")
		expect(out).toContain("STEP 5 — PLAN")
		expect(out).toContain("## Chunks")
		expect(out).toContain("Self-validation")
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
