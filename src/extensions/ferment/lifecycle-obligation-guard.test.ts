import { afterEach, describe, expect, it } from "vitest"
import type { DeclarativeAction } from "../../ferment/engine.js"
import type { Ferment } from "../../ferment/types.js"
import {
	type LifecycleObligation,
	MAX_LIFECYCLE_STOP_RETRIES,
	buildObligationKey,
	clearAllLifecycleGuards,
	clearLifecycleGuard,
	deriveObligation,
	evaluateLifecycleStop,
} from "./lifecycle-obligation-guard.js"

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeDraftFerment(overrides: Partial<Ferment> = {}): Ferment {
	const now = "2026-01-01T00:00:00.000Z"
	return {
		id: "ferment-1",
		name: "Test Ferment",
		status: "draft",
		worktree: { path: "/repo" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	}
}

function makePlannedFerment(overrides: Partial<Ferment> = {}): Ferment {
	return makeDraftFerment({
		id: "ferment-1",
		status: "planned",
		scoping: {
			goal: { answer: "Goal", confirmedAt: "2026-01-01T00:00:00.000Z" },
			criteria: { answer: "Criteria", confirmedAt: "2026-01-01T00:00:00.000Z" },
			constraints: { answer: "Constraints", confirmedAt: "2026-01-01T00:00:00.000Z" },
			phases: { answer: "1 phase", confirmedAt: "2026-01-01T00:00:00.000Z" },
		},
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Phase 1",
				goal: "Build",
				status: "planned",
				steps: [],
			},
		],
		...overrides,
	})
}

function makeRunningFermentWithStep(overrides: Partial<Ferment> = {}): Ferment {
	return makePlannedFerment({
		id: "ferment-1",
		status: "running",
		activePhaseId: "phase-1",
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Phase 1",
				goal: "Build",
				status: "active",
				steps: [
					{
						id: "step-1",
						index: 1,
						description: "Do the thing",
						status: "pending",
					},
				],
			},
		],
		...overrides,
	})
}

const scopeAction: DeclarativeAction = { kind: "scope", reason: "collect scope" }
const activatePhaseAction: DeclarativeAction = {
	kind: "activate_phase",
	phaseId: "phase-1",
	reason: "activate first planned phase",
}
const startStepAction: DeclarativeAction = {
	kind: "start_step",
	phaseId: "phase-1",
	stepId: "step-1",
	reason: "start next pending step",
	canParallel: false,
}
const completeFermentAction: DeclarativeAction = {
	kind: "complete_ferment",
	reason: "all phases terminal",
}
afterEach(() => {
	clearAllLifecycleGuards()
})

// ─── buildObligationKey ──────────────────────────────────────────────────────

describe("buildObligationKey", () => {
	it("builds a stable key for scope action", () => {
		expect(buildObligationKey("ferment-123", scopeAction)).toBe("ferment-123:scope")
	})

	it("builds a stable key for activate_phase action with phaseId", () => {
		expect(buildObligationKey("ferment-123", activatePhaseAction)).toBe("ferment-123:activate_phase:phase-1")
	})

	it("builds a stable key for start_step action with phaseId and stepId", () => {
		expect(buildObligationKey("ferment-123", startStepAction)).toBe("ferment-123:start_step:phase-1:step-1")
	})

	it("produces different keys for different step IDs", () => {
		const step2: DeclarativeAction = {
			kind: "start_step",
			phaseId: "phase-1",
			stepId: "step-2",
			reason: "start",
			canParallel: false,
		}
		expect(buildObligationKey("f", startStepAction)).not.toBe(buildObligationKey("f", step2))
	})
})

// ─── deriveObligation ────────────────────────────────────────────────────────

describe("deriveObligation", () => {
	it("derives scope obligation for a draft ferment under automated policy", () => {
		const f = makeDraftFerment()
		const obligation = deriveObligation(f, "automated")
		expect(obligation).toBeDefined()
		expect(obligation?.action.kind).toBe("scope")
		expect(obligation?.mode).toBe("concrete")
		expect(obligation?.toolName).toBe("scope_ferment")
		expect(obligation?.key).toBe("ferment-1:scope")
	})

	it("returns undefined under manual (interactive) policy", () => {
		const f = makeDraftFerment()
		expect(deriveObligation(f, "manual")).toBeUndefined()
	})

	it("derives activate_phase obligation for a planned ferment under automated policy", () => {
		const f = makePlannedFerment()
		const obligation = deriveObligation(f, "automated")
		expect(obligation).toBeDefined()
		expect(obligation?.action.kind).toBe("activate_phase")
		expect(obligation?.toolName).toBe("activate_ferment_phase")
	})

	it("derives start_step obligation for a running ferment with pending step", () => {
		const f = makeRunningFermentWithStep()
		const obligation = deriveObligation(f, "automated")
		expect(obligation).toBeDefined()
		expect(obligation?.action.kind).toBe("start_step")
		expect(obligation?.toolName).toBe("start_ferment_step")
	})

	it("returns undefined for a paused ferment (no continuable action)", () => {
		const f = makeDraftFerment({ status: "paused" })
		expect(deriveObligation(f, "automated")).toBeUndefined()
	})

	it("returns undefined for a complete ferment", () => {
		const f = makePlannedFerment({ status: "complete" })
		expect(deriveObligation(f, "automated")).toBeUndefined()
	})

	it("derives a choice-oriented obligation for recover_step", () => {
		const f = makeRunningFermentWithStep({
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Phase 1",
					goal: "Build",
					status: "active",
					steps: [{ id: "step-1", index: 1, description: "Do it", status: "failed" }],
				},
			],
		})
		const obligation = deriveObligation(f, "automated")
		expect(obligation?.action.kind).toBe("recover_step")
		expect(obligation?.mode).toBe("choice-oriented")
		expect(obligation?.toolName).toBeUndefined()
		expect(obligation?.key).toBe("ferment-1:recover_step:phase-1:step-1")
	})

	it("derives a choice-oriented obligation for recover_phase", () => {
		const f = makePlannedFerment({
			status: "running",
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Phase 1",
					goal: "Build",
					status: "failed",
					steps: [],
				},
			],
		})
		const obligation = deriveObligation(f, "automated")
		expect(obligation?.action.kind).toBe("recover_phase")
		expect(obligation?.mode).toBe("choice-oriented")
		expect(obligation?.toolName).toBeUndefined()
		expect(obligation?.key).toBe("ferment-1:recover_phase:phase-1")
	})
})

// ─── evaluateLifecycleStop ──────────────────────────────────────────────────

describe("evaluateLifecycleStop", () => {
	function makeObligation(action: DeclarativeAction, fermentId = "ferment-1"): LifecycleObligation {
		if (action.kind === "pause" || action.kind === "recover_step" || action.kind === "recover_phase") {
			throw new Error(`expected concrete lifecycle action, received ${action.kind}`)
		}
		return {
			fermentId,
			key: buildObligationKey(fermentId, action),
			action,
			mode: "concrete",
			toolName: "scope_ferment",
		}
	}

	it("first qualifying stop returns retry attempt 1", () => {
		const obligation = makeObligation(scopeAction)
		const decision = evaluateLifecycleStop(obligation)
		expect(decision.type).toBe("retry")
		if (decision.type === "retry") {
			expect(decision.attempt).toBe(1)
			expect(decision.maxAttempts).toBe(MAX_LIFECYCLE_STOP_RETRIES)
		}
	})

	it("second qualifying stop for the same key returns retry attempt 2", () => {
		const obligation = makeObligation(scopeAction)
		evaluateLifecycleStop(obligation)
		const decision = evaluateLifecycleStop(obligation)
		expect(decision.type).toBe("retry")
		if (decision.type === "retry") {
			expect(decision.attempt).toBe(2)
			expect(decision.maxAttempts).toBe(MAX_LIFECYCLE_STOP_RETRIES)
		}
	})

	it("third qualifying stop returns exhausted with report=true", () => {
		const obligation = makeObligation(scopeAction)
		evaluateLifecycleStop(obligation) // retry 1
		evaluateLifecycleStop(obligation) // retry 2
		const decision = evaluateLifecycleStop(obligation) // exhausted
		expect(decision.type).toBe("exhausted")
		if (decision.type === "exhausted") {
			expect(decision.report).toBe(true)
			expect(decision.attempts).toBe(3)
		}
	})

	it("re-evaluating an exhausted key does not request duplicate reporting", () => {
		const obligation = makeObligation(scopeAction)
		evaluateLifecycleStop(obligation) // retry 1
		evaluateLifecycleStop(obligation) // retry 2
		evaluateLifecycleStop(obligation) // exhausted, report=true
		const decision = evaluateLifecycleStop(obligation) // exhausted again
		expect(decision.type).toBe("exhausted")
		if (decision.type === "exhausted") {
			expect(decision.report).toBe(false)
		}
	})

	it("state advancement to a different action key provides a fresh budget", () => {
		// Exhaust the scope budget
		const scopeObligation = makeObligation(scopeAction)
		evaluateLifecycleStop(scopeObligation) // retry 1
		evaluateLifecycleStop(scopeObligation) // retry 2
		evaluateLifecycleStop(scopeObligation) // exhausted

		// Now the ferment advanced to activate_phase — different key, fresh budget
		const activateObligation = makeObligation(activatePhaseAction)
		const decision = evaluateLifecycleStop(activateObligation)
		expect(decision.type).toBe("retry")
		if (decision.type === "retry") {
			expect(decision.attempt).toBe(1)
		}
	})

	it("a different step ID produces a fresh budget", () => {
		const step1Obligation = makeObligation(startStepAction)
		evaluateLifecycleStop(step1Obligation) // retry 1
		evaluateLifecycleStop(step1Obligation) // retry 2

		const step2Action: DeclarativeAction = {
			kind: "start_step",
			phaseId: "phase-1",
			stepId: "step-2",
			reason: "start",
			canParallel: false,
		}
		const step2Obligation = makeObligation(step2Action)
		const decision = evaluateLifecycleStop(step2Obligation)
		expect(decision.type).toBe("retry")
		if (decision.type === "retry") {
			expect(decision.attempt).toBe(1)
		}
	})

	it("prunes old keys when a new current key is observed", () => {
		// Start with scope obligation
		const scopeObligation = makeObligation(scopeAction)
		evaluateLifecycleStop(scopeObligation)

		// Switch to activate_phase obligation — should prune the scope key
		const activateObligation = makeObligation(activatePhaseAction)
		evaluateLifecycleStop(activateObligation)

		// Now go back to scope — it should be a fresh budget because the old
		// scope key was pruned when activate_phase was observed.
		const decision = evaluateLifecycleStop(scopeObligation)
		expect(decision.type).toBe("retry")
		if (decision.type === "retry") {
			expect(decision.attempt).toBe(1)
		}
	})
})

// ─── clearLifecycleGuard ────────────────────────────────────────────────────

describe("clearLifecycleGuard", () => {
	it("clears all retry state for a ferment", () => {
		const obligation: LifecycleObligation = {
			fermentId: "ferment-1",
			key: buildObligationKey("ferment-1", scopeAction),
			action: scopeAction,
			mode: "concrete",
			toolName: "scope_ferment",
		}
		evaluateLifecycleStop(obligation) // retry 1
		evaluateLifecycleStop(obligation) // retry 2

		clearLifecycleGuard("ferment-1")

		// After clearing, the same obligation should start fresh
		const decision = evaluateLifecycleStop(obligation)
		expect(decision.type).toBe("retry")
		if (decision.type === "retry") {
			expect(decision.attempt).toBe(1)
		}
	})

	it("does not affect other ferments' state", () => {
		const obligation1: LifecycleObligation = {
			fermentId: "ferment-1",
			key: buildObligationKey("ferment-1", scopeAction),
			action: scopeAction,
			mode: "concrete",
			toolName: "scope_ferment",
		}
		const obligation2: LifecycleObligation = {
			fermentId: "ferment-2",
			key: buildObligationKey("ferment-2", scopeAction),
			action: scopeAction,
			mode: "concrete",
			toolName: "scope_ferment",
		}
		evaluateLifecycleStop(obligation1) // retry 1
		evaluateLifecycleStop(obligation2) // retry 1

		clearLifecycleGuard("ferment-1")

		// ferment-2 should still have its budget consumed
		const decision = evaluateLifecycleStop(obligation2)
		expect(decision.type).toBe("retry")
		if (decision.type === "retry") {
			expect(decision.attempt).toBe(2)
		}
	})
})

// ─── complete_ferment classification ─────────────────────────────────────────

describe("complete_ferment classification", () => {
	it("derives complete_ferment obligation when all phases are terminal", () => {
		const f = makePlannedFerment({
			status: "running",
			activePhaseId: "phase-1",
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Phase 1",
					goal: "Build",
					status: "completed",
					steps: [{ id: "step-1", index: 1, description: "Do it", status: "done" }],
				},
			],
		})
		const obligation = deriveObligation(f, "automated")
		expect(obligation).toBeDefined()
		expect(obligation?.action.kind).toBe("complete_ferment")
		expect(obligation?.toolName).toBe("complete_ferment")
	})

	it("complete_ferment obligation receives the standard retry budget", () => {
		const obligation: LifecycleObligation = {
			fermentId: "ferment-1",
			key: buildObligationKey("ferment-1", completeFermentAction),
			action: completeFermentAction,
			mode: "concrete",
			toolName: "complete_ferment",
		}
		const d1 = evaluateLifecycleStop(obligation)
		const d2 = evaluateLifecycleStop(obligation)
		const d3 = evaluateLifecycleStop(obligation)
		expect(d1.type).toBe("retry")
		expect(d2.type).toBe("retry")
		expect(d3.type).toBe("exhausted")
	})
})

// ─── choice-oriented recovery obligations ───────────────────────────────────

describe("choice-oriented recovery obligations", () => {
	it("recover_step receives the standard retry budget", () => {
		const f = makeRunningFermentWithStep({
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Phase 1",
					goal: "Build",
					status: "active",
					steps: [{ id: "step-1", index: 1, description: "Do it", status: "failed" }],
				},
			],
		})
		const obligation = deriveObligation(f, "automated")
		expect(obligation?.mode).toBe("choice-oriented")
		if (!obligation) throw new Error("expected recovery obligation")
		expect(evaluateLifecycleStop(obligation).type).toBe("retry")
		expect(evaluateLifecycleStop(obligation).type).toBe("retry")
		expect(evaluateLifecycleStop(obligation).type).toBe("exhausted")
	})

	it("recover_phase is classified as choice-oriented", () => {
		const f = makePlannedFerment({
			status: "running",
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Phase 1",
					goal: "Build",
					status: "failed",
					steps: [],
				},
			],
		})
		expect(deriveObligation(f, "automated")?.mode).toBe("choice-oriented")
	})
})

// ─── non-obligation actions ──────────────────────────────────────────────────

describe("non-obligation actions", () => {
	it("pause action is not classified as a concrete obligation", () => {
		// A paused ferment: decideContinuation returns "paused" → no obligation
		const f = makeDraftFerment({ status: "paused" })
		expect(deriveObligation(f, "automated")).toBeUndefined()
	})

	it("no action (idle) returns undefined", () => {
		// A complete ferment: determineNextAction returns undefined → no obligation
		const f = makePlannedFerment({ status: "complete" })
		expect(deriveObligation(f, "automated")).toBeUndefined()
	})
})

// ─── MAX_LIFECYCLE_STOP_RETRIES constant ─────────────────────────────────────

describe("MAX_LIFECYCLE_STOP_RETRIES", () => {
	it("is set to 2 (two retries after the original stop)", () => {
		expect(MAX_LIFECYCLE_STOP_RETRIES).toBe(2)
	})
})
