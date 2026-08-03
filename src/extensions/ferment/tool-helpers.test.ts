import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import * as sharedStatusLine from "../shared-status-line.js"
import { clearAllLifecycleGuards, deriveObligation, evaluateLifecycleStop } from "./lifecycle-obligation-guard.js"
import { createDefaultFermentRuntime, type FermentRuntime } from "./runtime.js"
import { createApplyAndPersist } from "./tool-helpers.js"

function createRuntime(): { runtime: FermentRuntime; storage: FermentEventStore; setActive: ReturnType<typeof vi.fn> } {
	const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-apply-test-")))
	const setActive = vi.fn()
	const runtime = {
		...createDefaultFermentRuntime(),
		getStorage: () => storage,
		setActive,
	}
	return { runtime, storage, setActive }
}

function scopeDraft(applyAndPersist: ReturnType<typeof createApplyAndPersist>, ferment: Ferment): Ferment {
	const outcome = applyAndPersist(ferment.id, {
		type: "scope",
		goal: "Goal",
		successCriteria: ["Works"],
		constraints: [],
		phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
	})
	if (!outcome.ok) throw new Error(outcome.error.message)
	return outcome.ferment
}

describe("createApplyAndPersist", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})
	afterEach(() => {
		clearAllLifecycleGuards()
	})

	it("uses the injected storage and updates active state on success", () => {
		const { runtime, storage, setActive } = createRuntime()
		const applyAndPersist = createApplyAndPersist(runtime)
		const ferment = storage.create("Injected Store")

		const outcome = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		expect(outcome.ok).toBe(true)
		expect(storage.get(ferment.id)?.status).toBe("planned")
		expect(setActive).toHaveBeenCalledWith(expect.objectContaining({ id: ferment.id, status: "planned" }))
	})

	it("notifies the runtime after a successful lifecycle transition", () => {
		const { runtime, storage } = createRuntime()
		const onLifecycleTransitionApplied = vi.fn()
		runtime.onLifecycleTransitionApplied = onLifecycleTransitionApplied
		const applyAndPersist = createApplyAndPersist(runtime)
		const ferment = storage.create("Transition Notification")

		const outcome = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		expect(outcome.ok).toBe(true)
		expect(onLifecycleTransitionApplied).toHaveBeenCalledOnce()
		expect(onLifecycleTransitionApplied).toHaveBeenCalledWith(ferment.id)
	})

	it("does not notify the runtime when a lifecycle transition is rejected", () => {
		const { runtime } = createRuntime()
		const onLifecycleTransitionApplied = vi.fn()
		runtime.onLifecycleTransitionApplied = onLifecycleTransitionApplied
		const applyAndPersist = createApplyAndPersist(runtime)

		const outcome = applyAndPersist("missing-ferment", { type: "complete_ferment" })

		expect(outcome.ok).toBe(false)
		expect(onLifecycleTransitionApplied).not.toHaveBeenCalled()
	})

	it("grants a fresh retry budget when an exhausted obligation recurs after lifecycle progress", () => {
		const { runtime, storage } = createRuntime()
		const applyAndPersist = createApplyAndPersist(runtime)
		const planned = scopeDraft(applyAndPersist, storage.create("Recurring Recovery"))
		const phase = planned.phases[0]
		const step = phase.steps[0]
		const activated = applyAndPersist(planned.id, { type: "activate_phase", phaseId: phase.id })
		expect(activated.ok).toBe(true)
		const started = applyAndPersist(planned.id, { type: "start_step", phaseId: phase.id, stepId: step.id })
		expect(started.ok).toBe(true)
		const firstFailure = applyAndPersist(planned.id, {
			type: "fail_step",
			phaseId: phase.id,
			stepId: step.id,
			error: "first failure",
		})
		if (!firstFailure.ok) throw new Error(firstFailure.error.message)

		const firstObligation = deriveObligation(firstFailure.ferment, "automated")
		if (!firstObligation) throw new Error("expected the first recovery obligation")
		evaluateLifecycleStop(firstObligation)
		evaluateLifecycleStop(firstObligation)
		const exhausted = evaluateLifecycleStop(firstObligation)
		expect(exhausted).toMatchObject({ type: "exhausted", report: true })

		const restarted = applyAndPersist(planned.id, { type: "start_step", phaseId: phase.id, stepId: step.id })
		expect(restarted.ok).toBe(true)
		const secondFailure = applyAndPersist(planned.id, {
			type: "fail_step",
			phaseId: phase.id,
			stepId: step.id,
			error: "second failure",
		})
		if (!secondFailure.ok) throw new Error(secondFailure.error.message)

		const recurringObligation = deriveObligation(secondFailure.ferment, "automated")
		if (!recurringObligation) throw new Error("expected the recurring recovery obligation")
		expect(recurringObligation.key).toBe(firstObligation.key)
		expect(evaluateLifecycleStop(recurringObligation)).toMatchObject({ type: "retry", attempt: 1 })
	})

	it("writes state-machine commands through mutateWithEvents", () => {
		const { runtime, storage } = createRuntime()
		const mutateSpy = vi.spyOn(storage, "mutateWithEvents")
		const applyAndPersist = createApplyAndPersist(runtime)
		const ferment = storage.create("Event Backed")

		const outcome = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		expect(outcome.ok).toBe(true)
		expect(mutateSpy).toHaveBeenCalledTimes(1)
	})

	it("uses the injected clock for state-machine timestamps", () => {
		const { runtime, storage } = createRuntime()
		runtime.nowIso = () => "2026-05-11T12:34:56.000Z"
		const applyAndPersist = createApplyAndPersist(runtime)
		const ferment = storage.create("Clocked")

		const outcome = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build" }],
		})

		expect(outcome.ok).toBe(true)
		expect(storage.get(ferment.id)?.updatedAt).toBe("2026-05-11T12:34:56.000Z")
	})

	it("rejects non-resume commands while paused", () => {
		const { runtime, storage } = createRuntime()
		const applyAndPersist = createApplyAndPersist(runtime)
		const planned = scopeDraft(applyAndPersist, storage.create("Paused"))
		const pauseOutcome = applyAndPersist(planned.id, { type: "pause" })
		if (!pauseOutcome.ok) throw new Error(pauseOutcome.error.message)

		const outcome = applyAndPersist(planned.id, {
			type: "update_scope_field",
			field: "goal",
			value: "new goal",
		})

		expect(outcome.ok).toBe(false)
		if (!outcome.ok) expect(outcome.error.code).toBe("FERMENT_PAUSED")
	})

	it("allows resume while paused", () => {
		const { runtime, storage } = createRuntime()
		const applyAndPersist = createApplyAndPersist(runtime)
		const planned = scopeDraft(applyAndPersist, storage.create("Resume"))
		const pauseOutcome = applyAndPersist(planned.id, { type: "pause" })
		if (!pauseOutcome.ok) throw new Error(pauseOutcome.error.message)

		const outcome = applyAndPersist(planned.id, { type: "resume" })

		expect(outcome.ok).toBe(true)
		if (outcome.ok) expect(outcome.ferment.status).toBe("planned")
	})

	it("requests a status-line re-render after every successful mutation", () => {
		// Regression: tool-call mutations (start_ferment_step, complete_ferment_step,
		// activate_ferment_phase, ...) flow through createApplyAndPersist. The status
		// line's ferment segment reads getActive() at render time, so without an explicit
		// render request the status line goes stale until a keypress or message
		// render happens. Each successful mutation must trigger requestSharedStatusLineRender.
		const renderSpy = vi.spyOn(sharedStatusLine, "requestSharedStatusLineRender").mockImplementation(() => {})
		const { runtime, storage } = createRuntime()
		const applyAndPersist = createApplyAndPersist(runtime)
		const ferment = scopeDraft(applyAndPersist, storage.create("Render On Mutate"))
		renderSpy.mockClear()

		// Successful mutation triggers a render request.
		const phase = ferment.phases[0]
		const activate = applyAndPersist(ferment.id, { type: "activate_phase", phaseId: phase.id })
		expect(activate.ok).toBe(true)
		expect(renderSpy).toHaveBeenCalledTimes(1)

		// Failed mutation does NOT trigger a render request (no state change).
		// complete_ferment fails because the phase is still active (non-terminal).
		renderSpy.mockClear()
		const reject = applyAndPersist(ferment.id, { type: "complete_ferment" })
		expect(reject.ok).toBe(false)
		expect(renderSpy).not.toHaveBeenCalled()
		renderSpy.mockRestore()
	})
})
