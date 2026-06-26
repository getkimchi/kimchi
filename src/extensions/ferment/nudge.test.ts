import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import {
	hasScopingProgressTool,
	maybeInjectFermentStopNudge,
	maybeInjectReactiveContinuationNudge,
	maybeInjectScopingProgressNudge,
	maybeInjectScopingStopNudge,
	onFermentToolCallSeen,
	onStepCompleted,
	resetAllFermentStopNudgeCounts,
	resetAllReactiveContinuationNudgeCounts,
	resetScopingStopNudgeCount,
} from "./nudge.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { MAX_SCOPING_EXPLORE_TURNS, getActive, resetScopingExploreTurns, setActive } from "./state.js"
import { createApplyAndPersist } from "./tool-helpers.js"

function createPi(): ExtensionAPI {
	return {
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI
}

function makeDraftFerment(overrides: Partial<Ferment> = {}): Ferment {
	const now = "2026-01-01T00:00:00.000Z"
	return {
		id: "ferment-1",
		name: "Injected Nudge",
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

afterEach(() => {
	setActive(undefined)
	resetAllReactiveContinuationNudgeCounts()
	resetAllFermentStopNudgeCounts()
	resetScopingExploreTurns("ferment-1")
})

describe("ferment nudges", () => {
	it("syncs active state from injected storage on step completion", () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-nudge-test-")))
		const setActiveSpy = vi.fn()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			getActiveId: () => "ferment-1",
			setActive: setActiveSpy,
			isAutomatedContinuationEnabled: () => false,
		}
		const applyAndPersist = createApplyAndPersist(runtime)
		const draft = storage.create("Injected Store")
		const scoped = applyAndPersist(draft.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		runtime.getActiveId = () => scoped.ferment.id

		onStepCompleted(runtime)

		expect(setActiveSpy).toHaveBeenCalledWith(expect.objectContaining({ id: scoped.ferment.id }))
		expect(getActive()).toBeUndefined()
	})

	it("reactively nudges after a stalled assistant turn", () => {
		const pi = createPi()
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-reactive-nudge-test-")))
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			getActiveId: () => "ferment-1",
			getContinuationPolicy: () => "automated",
			isAutomatedContinuationEnabled: () => true,
		}
		const applyAndPersist = createApplyAndPersist(runtime)
		const draft = storage.create("Reactive Nudge")
		const scoped = applyAndPersist(draft.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		runtime.getActiveId = () => draft.id

		maybeInjectReactiveContinuationNudge(pi, runtime)

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_continuation_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("activate_ferment_phase") })],
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		)
	})

	it("reactively nudges an automated ferment across a completed phase boundary", () => {
		const pi = createPi()
		const boundary = makeDraftFerment({
			status: "planned",
			phases: [
				{ id: "phase-1", index: 1, name: "Done", goal: "Build", status: "completed", steps: [] },
				{ id: "phase-2", index: 2, name: "Next", goal: "Continue", status: "planned", steps: [] },
			],
		})
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActiveId: () => boundary.id,
			getStorage: () =>
				({
					get: () => boundary,
				}) as unknown as FermentRuntime["getStorage"] extends () => infer T ? T : never,
			getContinuationPolicy: () => "automated",
			isAutomatedContinuationEnabled: () => true,
		}

		maybeInjectReactiveContinuationNudge(pi, runtime)

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_continuation_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("activate_ferment_phase") })],
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		)
	})

	it("does not reactively nudge after the ferment is complete", () => {
		const pi = createPi()
		const setActiveSpy = vi.fn()
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-reactive-complete-test-")))
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			getActiveId: () => "ferment-1",
			setActive: setActiveSpy,
			getContinuationPolicy: () => "automated",
			isAutomatedContinuationEnabled: () => true,
		}
		const applyAndPersist = createApplyAndPersist(runtime)
		const draft = storage.create("Complete Nudge")
		const scoped = applyAndPersist(draft.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(draft.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const completedPhase = applyAndPersist(draft.id, {
			type: "complete_phase",
			phaseId: "phase-1",
			summary: "done",
		})
		if (!completedPhase.ok) throw new Error(completedPhase.error.message)
		const completed = applyAndPersist(draft.id, { type: "complete_ferment" })
		if (!completed.ok) throw new Error(completed.error.message)
		runtime.getActiveId = () => draft.id

		maybeInjectReactiveContinuationNudge(pi, runtime)

		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(setActiveSpy).toHaveBeenCalledWith(undefined)
	})

	it("does not count idle reactive checks toward the loop guard", () => {
		const pi = createPi()
		const readyToComplete = makeDraftFerment({
			status: "planned",
			phases: [{ id: "phase-1", index: 1, name: "Phase", goal: "Build", status: "completed", steps: [] }],
		})
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActiveId: () => readyToComplete.id,
			getStorage: () =>
				({
					get: () => readyToComplete,
				}) as unknown as FermentRuntime["getStorage"] extends () => infer T ? T : never,
			getContinuationPolicy: () => "automated",
			isAutomatedContinuationEnabled: () => true,
		}

		maybeInjectReactiveContinuationNudge(pi, runtime)
		maybeInjectReactiveContinuationNudge(pi, runtime)
		maybeInjectReactiveContinuationNudge(pi, runtime)
		maybeInjectReactiveContinuationNudge(pi, runtime)

		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.appendEntry).not.toHaveBeenCalledWith(
			"ferment_breadcrumb",
			expect.objectContaining({ text: expect.stringContaining("Continuation nudge suppressed") }),
		)
	})

	it("suppresses repeated reactive nudges after the loop guard cap", () => {
		const pi = createPi()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActive: () =>
				makeDraftFerment({
					status: "planned",
					phases: [{ id: "phase-1", index: 1, name: "Phase", goal: "Build", status: "planned", steps: [] }],
				}),
			getActiveId: () => "ferment-1",
			getStorage: () =>
				({
					get: () =>
						makeDraftFerment({
							status: "planned",
							phases: [{ id: "phase-1", index: 1, name: "Phase", goal: "Build", status: "planned", steps: [] }],
						}),
				}) as unknown as FermentRuntime["getStorage"] extends () => infer T ? T : never,
			getContinuationPolicy: () => "automated",
			isAutomatedContinuationEnabled: () => true,
		}

		maybeInjectReactiveContinuationNudge(pi, runtime)
		maybeInjectReactiveContinuationNudge(pi, runtime)
		maybeInjectReactiveContinuationNudge(pi, runtime)
		maybeInjectReactiveContinuationNudge(pi, runtime)

		// With cap=1: call 1 fires (schedules action), calls 2-4 each emit one
		// suppression breadcrumb via pi.sendMessage. Assert on the last
		// suppression message rather than total call count, which depends on
		// scheduleNextFermentAction internals.
		expect(pi.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				customType: "ferment_breadcrumb",
				details: expect.objectContaining({ text: expect.stringContaining("Continuation nudge suppressed after 1") }),
			}),
			expect.anything(),
		)
	})

	it("prunes the reactive loop guard when a ferment is paused", () => {
		const pi = createPi()
		let current = makeDraftFerment({
			status: "planned",
			phases: [{ id: "phase-1", index: 1, name: "Phase", goal: "Build", status: "planned", steps: [] }],
		})
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActiveId: () => "ferment-1",
			getStorage: () =>
				({
					get: () => current,
				}) as unknown as FermentRuntime["getStorage"] extends () => infer T ? T : never,
			getContinuationPolicy: () => "automated",
			isAutomatedContinuationEnabled: () => true,
		}

		maybeInjectReactiveContinuationNudge(pi, runtime)
		maybeInjectReactiveContinuationNudge(pi, runtime)
		maybeInjectReactiveContinuationNudge(pi, runtime)
		current = { ...current, status: "paused" }
		maybeInjectReactiveContinuationNudge(pi, runtime)
		current = { ...current, status: "planned" }
		maybeInjectReactiveContinuationNudge(pi, runtime)

		// With cap=1: call 1 fires (1 msg via scheduler), call 2 suppressed (1 breadcrumb),
		// call 3 suppressed (1 breadcrumb), call 4 paused resets the counter (0 msgs),
		// call 5 fires again (1 msg). Total: 1 + 1 + 1 + 0 + 1 = 4.
		expect(pi.sendMessage).toHaveBeenCalledTimes(4)
	})

	it("reactively nudges failed phase recovery with retry and bypass actions", () => {
		const pi = createPi()
		const failed = makeDraftFerment({
			status: "planned",
			phases: [{ id: "phase-1", index: 1, name: "Phase", goal: "Build", status: "failed", steps: [] }],
		})
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActiveId: () => failed.id,
			getStorage: () =>
				({
					get: () => failed,
				}) as unknown as FermentRuntime["getStorage"] extends () => infer T ? T : never,
			getContinuationPolicy: () => "automated",
			isAutomatedContinuationEnabled: () => true,
		}

		maybeInjectReactiveContinuationNudge(pi, runtime)

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: [
					expect.objectContaining({
						text: expect.stringContaining("failed phase"),
					}),
				],
				details: expect.objectContaining({ action: "recover_phase" }),
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		)
	})
})

describe("scoping progress nudge", () => {
	it("hasScopingProgressTool detects scoping-advancement tools", () => {
		expect(hasScopingProgressTool(["read", "grep", "ls"])).toBe(false)
		expect(hasScopingProgressTool(["read", "ask_user"])).toBe(true)
		expect(hasScopingProgressTool(["confirm_ferment_completion_criteria"])).toBe(true)
		expect(hasScopingProgressTool(["propose_ferment_scoping"])).toBe(true)
		expect(hasScopingProgressTool(["Agent"])).toBe(true)
		expect(hasScopingProgressTool([])).toBe(false)
	})

	it("does not nudge before reaching the turn threshold", () => {
		const pi = createPi()
		const fermentId = "ferment-1"

		// One turn short of the threshold — should not nudge yet.
		for (let i = 0; i < MAX_SCOPING_EXPLORE_TURNS - 1; i++) {
			expect(maybeInjectScopingProgressNudge(pi, fermentId, ["read"])).toBe(false)
		}
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("nudges after reaching the turn threshold", () => {
		const pi = createPi()
		const fermentId = "ferment-1"

		for (let i = 0; i < MAX_SCOPING_EXPLORE_TURNS - 1; i++) {
			maybeInjectScopingProgressNudge(pi, fermentId, ["read"])
		}
		const nudged = maybeInjectScopingProgressNudge(pi, fermentId, ["read"])

		expect(nudged).toBe(true)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_scoping_progress_nudge",
				content: [
					expect.objectContaining({
						text: expect.stringContaining("SCOPING PROGRESS CHECK"),
					}),
				],
			}),
			{ triggerTurn: true },
		)
	})

	it("resets the counter when a scoping-progress tool is seen", () => {
		const pi = createPi()
		const fermentId = "ferment-1"

		// Explore right up to (but not including) the threshold, then a progress
		// tool call resets the counter.
		for (let i = 0; i < MAX_SCOPING_EXPLORE_TURNS - 1; i++) {
			maybeInjectScopingProgressNudge(pi, fermentId, ["read"])
		}
		maybeInjectScopingProgressNudge(pi, fermentId, ["ask_user"]) // resets
		expect(pi.sendMessage).not.toHaveBeenCalled()

		// Need another full MAX_SCOPING_EXPLORE_TURNS turns to trigger again.
		for (let i = 0; i < MAX_SCOPING_EXPLORE_TURNS - 1; i++) {
			maybeInjectScopingProgressNudge(pi, fermentId, ["read"])
		}
		const nudged = maybeInjectScopingProgressNudge(pi, fermentId, ["read"])

		expect(nudged).toBe(true)
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("resets the counter after a nudge so it does not spam every turn", () => {
		const pi = createPi()
		const fermentId = "ferment-1"

		// Trigger the first nudge
		for (let i = 0; i < MAX_SCOPING_EXPLORE_TURNS; i++) {
			maybeInjectScopingProgressNudge(pi, fermentId, ["read"])
		}

		// Next turn should NOT trigger immediately
		const nudged = maybeInjectScopingProgressNudge(pi, fermentId, ["read"])
		expect(nudged).toBe(false)
		expect(pi.sendMessage).toHaveBeenCalledTimes(1) // only the first nudge
	})

	it("recognises scope_ferment as a scoping-progress tool (one-shot mode)", () => {
		const pi = createPi()
		const fermentId = "ferment-1"

		// Explore right up to (but not including) the threshold, then call
		// scope_ferment — the counter should reset and no nudge should fire.
		for (let i = 0; i < MAX_SCOPING_EXPLORE_TURNS - 1; i++) {
			maybeInjectScopingProgressNudge(pi, fermentId, ["read"])
		}
		const nudged = maybeInjectScopingProgressNudge(pi, fermentId, ["scope_ferment"])

		expect(nudged).toBe(false)
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("emits one-shot specific nudge text when interactive=false", () => {
		const pi = createPi()
		const fermentId = "ferment-1"

		for (let i = 0; i < MAX_SCOPING_EXPLORE_TURNS - 1; i++) {
			maybeInjectScopingProgressNudge(pi, fermentId, ["read"], { interactive: false })
		}
		const nudged = maybeInjectScopingProgressNudge(pi, fermentId, ["read"], { interactive: false })

		expect(nudged).toBe(true)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: [
					expect.objectContaining({
						text: expect.stringContaining("questions route automatically to the judge"),
					}),
				],
			}),
			expect.anything(),
		)
	})
})

describe("maybeInjectScopingStopNudge", () => {
	const fermentId = "ferment-stop"

	afterEach(() => {
		resetScopingStopNudgeCount(fermentId)
	})

	it("fires when stopReason is 'stop' and no scoping tool was called", () => {
		const pi = createPi()
		const nudged = maybeInjectScopingStopNudge(pi, fermentId, ["read", "grep"], "stop")

		expect(nudged).toBe(true)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_scoping_stop_nudge",
				content: [
					expect.objectContaining({
						text: expect.stringContaining("You stopped during ferment scoping"),
					}),
				],
			}),
			{ triggerTurn: true },
		)
	})

	it("does not fire when the turn called scope_ferment", () => {
		const pi = createPi()
		const nudged = maybeInjectScopingStopNudge(pi, fermentId, ["read", "scope_ferment"], "stop")

		expect(nudged).toBe(false)
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("does not fire when the turn called propose_ferment_scoping", () => {
		const pi = createPi()
		const nudged = maybeInjectScopingStopNudge(pi, fermentId, ["propose_ferment_scoping"], "stop")

		expect(nudged).toBe(false)
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("does not fire when stopReason is not 'stop'", () => {
		const pi = createPi()
		const nudged = maybeInjectScopingStopNudge(pi, fermentId, ["read"], "end_turn")

		expect(nudged).toBe(false)
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("does not fire when no tools were called (pure text turn)", () => {
		const pi = createPi()
		const nudged = maybeInjectScopingStopNudge(pi, fermentId, [], "stop")

		expect(nudged).toBe(false)
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("suppresses additional nudges after the cap is hit", () => {
		const pi = createPi()

		// Fires up to MAX_PLANNING_STOP_NUDGES times.
		maybeInjectScopingStopNudge(pi, fermentId, ["read"], "stop")
		maybeInjectScopingStopNudge(pi, fermentId, ["read"], "stop")
		const third = maybeInjectScopingStopNudge(pi, fermentId, ["read"], "stop")

		expect(third).toBe(false)
		expect(pi.sendMessage).toHaveBeenCalledTimes(2)
	})
})

describe("maybeInjectFermentStopNudge", () => {
	function makeRunningFerment(overrides: Partial<Ferment> = {}): Ferment {
		return makeDraftFerment({
			status: "planned",
			phases: [{ id: "phase-1", index: 1, name: "Phase", goal: "Build", status: "planned", steps: [] }],
			...overrides,
		})
	}

	function makeRuntime(ferment: Ferment, automated = true): FermentRuntime {
		return {
			...createDefaultFermentRuntime(),
			getActiveId: () => ferment.id,
			getStorage: () =>
				({
					get: () => ferment,
				}) as unknown as FermentRuntime["getStorage"] extends () => infer T ? T : never,
			getContinuationPolicy: () => "automated",
			isAutomatedContinuationEnabled: () => automated,
		}
	}

	it("nudges when the ferment still needs action and the model stopped after tool calls", () => {
		const pi = createPi()
		const ferment = makeRunningFerment()
		const runtime = makeRuntime(ferment)

		const nudged = maybeInjectFermentStopNudge(pi, runtime)

		expect(nudged).toBe(true)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_continuation_nudge" }),
			expect.objectContaining({ deliverAs: "followUp" }),
		)
	})

	it("does not nudge when automated continuation is disabled", () => {
		const pi = createPi()
		const ferment = makeRunningFerment()
		const runtime = makeRuntime(ferment, false)

		const nudged = maybeInjectFermentStopNudge(pi, runtime)

		expect(nudged).toBe(false)
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("does not nudge when there is no active ferment", () => {
		const pi = createPi()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActiveId: () => undefined,
			isAutomatedContinuationEnabled: () => true,
		}

		const nudged = maybeInjectFermentStopNudge(pi, runtime)

		expect(nudged).toBe(false)
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("does not nudge when the ferment is complete", () => {
		const pi = createPi()
		const ferment = makeRunningFerment({ status: "complete" })
		const runtime = makeRuntime(ferment)

		const nudged = maybeInjectFermentStopNudge(pi, runtime)

		expect(nudged).toBe(false)
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("does not nudge when the ferment is paused", () => {
		const pi = createPi()
		const ferment = makeRunningFerment({ status: "paused" })
		const runtime = makeRuntime(ferment)

		const nudged = maybeInjectFermentStopNudge(pi, runtime)

		expect(nudged).toBe(false)
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("nudges when all phases are complete but complete_ferment has not been called yet", () => {
		const pi = createPi()
		// All phases terminal → engine returns complete_ferment action.
		// The stop-nudge path must treat this as continuable so the final
		// lifecycle step is not left unfinished.
		const ferment = makeRunningFerment({
			status: "planned",
			phases: [{ id: "phase-1", index: 1, name: "Phase", goal: "Build", status: "completed", steps: [] }],
		})
		const runtime = makeRuntime(ferment)

		const nudged = maybeInjectFermentStopNudge(pi, runtime)

		expect(nudged).toBe(true)
		expect(pi.sendMessage).toHaveBeenCalled()
	})

	it("suppresses after reaching the consecutive stop-nudge cap", () => {
		const pi = createPi()
		const ferment = makeRunningFerment()
		const runtime = makeRuntime(ferment)

		// First two nudges fire (cap is 2)
		maybeInjectFermentStopNudge(pi, runtime)
		maybeInjectFermentStopNudge(pi, runtime)
		// Third is suppressed with a breadcrumb
		const nudged = maybeInjectFermentStopNudge(pi, runtime)

		expect(nudged).toBe(false)
		expect(pi.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				customType: "ferment_breadcrumb",
				details: expect.objectContaining({ text: expect.stringContaining("Ferment stop nudge suppressed after 2") }),
			}),
			expect.anything(),
		)
	})

	it("resets the stop-nudge counter when a tool call is seen via onFermentToolCallSeen", () => {
		const pi = createPi()
		const ferment = makeRunningFerment()
		const runtime = makeRuntime(ferment)

		// Consume all nudge budget
		maybeInjectFermentStopNudge(pi, runtime)
		maybeInjectFermentStopNudge(pi, runtime)

		// Simulate the agent making a tool call → resets the counter
		onFermentToolCallSeen(ferment.id)

		// Budget is reset, so a new nudge should fire
		const nudged = maybeInjectFermentStopNudge(pi, runtime)
		expect(nudged).toBe(true)
	})

	it("does not interfere with the reactive (text-only) nudge counter", () => {
		const pi = createPi()
		const ferment = makeRunningFerment()
		const runtime = makeRuntime(ferment)

		// Exhaust the reactive nudge budget (cap=1) via maybeInjectReactiveContinuationNudge
		maybeInjectReactiveContinuationNudge(pi, runtime)
		maybeInjectReactiveContinuationNudge(pi, runtime) // suppressed by reactive cap

		// Stop nudge should still fire on a fresh counter
		const nudged = maybeInjectFermentStopNudge(pi, runtime)
		expect(nudged).toBe(true)
	})
})
