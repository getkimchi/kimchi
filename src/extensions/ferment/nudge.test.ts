import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import { clearAllLifecycleGuards, maybeInjectLifecycleObligationGuard } from "./lifecycle-obligation-guard.js"
import {
	hasScopingProgressTool,
	maybeInjectFermentStopNudge,
	maybeInjectScopingProgressNudge,
	maybeInjectScopingStopNudge,
	onFermentToolCallSeen,
	onStepCompleted,
	resetAllFermentStopNudgeCounts,
	resetScopingStopNudgeCount,
} from "./nudge.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { MAX_SCOPING_EXPLORE_TURNS, getActive, resetScopingExploreTurns, setActive } from "./state.js"
import { filterSentMessages } from "./test-helpers.js"
import { createApplyAndPersist } from "./tool-helpers.js"

function createPi(): ExtensionAPI {
	return {
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		events: { emit: vi.fn() },
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
	clearAllLifecycleGuards()
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
})

// ─── Lifecycle obligation guard (replaces reactive continuation nudge) ────────

describe("maybeInjectLifecycleObligationGuard", () => {
	function makePlannedFerment(overrides: Partial<Ferment> = {}): Ferment {
		return makeDraftFerment({
			status: "planned",
			scoping: {
				goal: { answer: "Goal", confirmedAt: "2026-01-01T00:00:00.000Z" },
				criteria: { answer: "Criteria", confirmedAt: "2026-01-01T00:00:00.000Z" },
				constraints: { answer: "Constraints", confirmedAt: "2026-01-01T00:00:00.000Z" },
				phases: { answer: "1 phase", confirmedAt: "2026-01-01T00:00:00.000Z" },
			},
			phases: [{ id: "phase-1", index: 1, name: "Phase", goal: "Build", status: "planned", steps: [] }],
			...overrides,
		})
	}

	function makeRuntime(ferment: Ferment, automated = true): FermentRuntime {
		const events = { emit: vi.fn() } as unknown as FermentRuntime["events"]
		return {
			...createDefaultFermentRuntime(),
			events,
			getActiveId: () => ferment.id,
			getStorage: () =>
				({
					get: () => ferment,
				}) as unknown as FermentRuntime["getStorage"] extends () => infer T ? T : never,
			getContinuationPolicy: () => (automated ? "automated" : "manual"),
			isAutomatedContinuationEnabled: () => automated,
		}
	}

	it("nudges after a stalled assistant turn under automated policy", () => {
		const pi = createPi()
		const ferment = makePlannedFerment()
		const runtime = makeRuntime(ferment)

		maybeInjectLifecycleObligationGuard(pi, runtime)

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_continuation_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("activate_ferment_phase") })],
			}),
			{ triggerTurn: true, deliverAs: "steer" },
		)
	})

	it("does not nudge under manual (interactive) policy", () => {
		const pi = createPi()
		const ferment = makePlannedFerment()
		const runtime = makeRuntime(ferment, false)

		maybeInjectLifecycleObligationGuard(pi, runtime)

		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("does not nudge after the ferment is complete", () => {
		const pi = createPi()
		const setActiveSpy = vi.fn()
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-guard-complete-test-")))
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

		maybeInjectLifecycleObligationGuard(pi, runtime)

		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(setActiveSpy).toHaveBeenCalledWith(undefined)
	})

	it("does not count idle actions toward the retry budget", () => {
		const pi = createPi()
		// All phases complete → engine returns complete_ferment, but with
		// treatCompleteFermentAsContinue the guard treats it as continuable.
		// A planned ferment with no phases → engine returns scope, which is continuable.
		// Use a ferment where decideContinuation returns "idle" (no action):
		// a complete ferment has no action.
		const readyToComplete = makePlannedFerment({
			status: "complete",
			phases: [{ id: "phase-1", index: 1, name: "Phase", goal: "Build", status: "completed", steps: [] }],
		})
		const runtime = makeRuntime(readyToComplete)

		maybeInjectLifecycleObligationGuard(pi, runtime)
		maybeInjectLifecycleObligationGuard(pi, runtime)
		maybeInjectLifecycleObligationGuard(pi, runtime)
		maybeInjectLifecycleObligationGuard(pi, runtime)

		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("schedules a second retry for the same obligation before exhausting", () => {
		const pi = createPi()
		const ferment = makePlannedFerment()
		const runtime = makeRuntime(ferment)

		maybeInjectLifecycleObligationGuard(pi, runtime) // retry 1
		maybeInjectLifecycleObligationGuard(pi, runtime) // retry 2

		// Both calls should have scheduled a continuation nudge (steer).
		const calls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_continuation_nudge")
		expect(calls.length).toBe(2)
	})

	it("makes the second retry stricter than the first", () => {
		const pi = createPi()
		const ferment = makePlannedFerment()
		const runtime = makeRuntime(ferment)

		maybeInjectLifecycleObligationGuard(pi, runtime)
		maybeInjectLifecycleObligationGuard(pi, runtime)

		const calls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_continuation_nudge")
		const firstText = calls[0]?.content?.[0]?.text
		const secondText = calls[1]?.content?.[0]?.text
		expect(firstText).toContain("previous turn stopped without a tool call")
		expect(secondText).toContain("retry 2/2")
		expect(secondText).toContain("Do not respond with an announcement or summary")
		expect(secondText).not.toBe(firstText)
	})

	it("emits an exhaustion diagnostic on the third stop and suppresses on the fourth", () => {
		const pi = createPi()
		const ferment = makePlannedFerment()
		const runtime = makeRuntime(ferment)

		maybeInjectLifecycleObligationGuard(pi, runtime) // retry 1
		maybeInjectLifecycleObligationGuard(pi, runtime) // retry 2
		const third = maybeInjectLifecycleObligationGuard(pi, runtime) // exhausted, report
		const fourth = maybeInjectLifecycleObligationGuard(pi, runtime) // exhausted, no report

		expect(third).toBe(true)
		expect(fourth).toBe(true) // guard acted (suppressed), but no new message

		// The third call should have emitted a visible breadcrumb + telemetry
		const breadcrumbCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_breadcrumb")
		expect(breadcrumbCalls.length).toBe(1)
		expect(breadcrumbCalls[0]?.content?.[0]?.text).toContain("Lifecycle guard exhausted")
		expect(runtime.events?.emit).toHaveBeenCalledWith(
			"ferment:stalled",
			expect.objectContaining({ fermentId: ferment.id }),
		)
	})

	it("prunes the retry budget when a ferment is paused", () => {
		const pi = createPi()
		let current = makePlannedFerment()
		const runtime = makeRuntime(current)

		maybeInjectLifecycleObligationGuard(pi, runtime) // retry 1
		maybeInjectLifecycleObligationGuard(pi, runtime) // retry 2

		// Pause the ferment — the guard should clear the budget and do nothing.
		current = { ...current, status: "paused" }
		runtime.getActiveId = () => current.id
		runtime.getStorage = () =>
			({
				get: () => current,
			}) as unknown as FermentRuntime["getStorage"] extends () => infer T ? T : never

		const pausedResult = maybeInjectLifecycleObligationGuard(pi, runtime)
		expect(pausedResult).toBe(false)

		// Resume — the budget should be fresh, so retry 1 fires again.
		current = { ...current, status: "planned" }
		const resumedResult = maybeInjectLifecycleObligationGuard(pi, runtime)
		expect(resumedResult).toBe(true)
	})

	it("nudges recover_phase with choice-oriented guidance and bounded exhaustion", () => {
		const pi = createPi()
		const failed = makePlannedFerment({
			status: "running",
			phases: [{ id: "phase-1", index: 1, name: "Failed", goal: "Build", status: "failed", steps: [] }],
		})
		const runtime = makeRuntime(failed)

		maybeInjectLifecycleObligationGuard(pi, runtime)
		maybeInjectLifecycleObligationGuard(pi, runtime)
		maybeInjectLifecycleObligationGuard(pi, runtime)

		const continuationCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_continuation_nudge")
		expect(continuationCalls).toHaveLength(2)
		const firstText = continuationCalls[0]?.content?.[0]?.text
		expect(firstText).toContain("requires recovery from the failed phase")
		expect(firstText).toContain("activate_ferment_phase to retry")
		expect(firstText).toContain("skip_ferment_phase")

		const warningCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_breadcrumb", "warning")
		expect(warningCalls).toHaveLength(1)
		const warningText = warningCalls[0]?.content?.[0]?.text
		expect(warningText).toContain('required recovery action "recover_phase" remained unresolved')
		expect(warningText).toContain("qualifying text-only stops for the unchanged obligation")
		expect(warningText).not.toContain("consecutive text-only stops")
	})

	it("nudges across a completed phase boundary", () => {
		const pi = createPi()
		const boundary = makePlannedFerment({
			status: "planned",
			phases: [
				{ id: "phase-1", index: 1, name: "Done", goal: "Build", status: "completed", steps: [] },
				{ id: "phase-2", index: 2, name: "Next", goal: "Continue", status: "planned", steps: [] },
			],
		})
		const runtime = makeRuntime(boundary)

		maybeInjectLifecycleObligationGuard(pi, runtime)

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_continuation_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("activate_ferment_phase") })],
			}),
			{ triggerTurn: true, deliverAs: "steer" },
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
			expect.objectContaining({ deliverAs: "steer" }),
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

	it("does not interfere with the lifecycle obligation guard counter", () => {
		const pi = createPi()
		const ferment = makeRunningFerment()
		const runtime = makeRuntime(ferment)

		// Exhaust the lifecycle guard budget (cap=2) via maybeInjectLifecycleObligationGuard
		maybeInjectLifecycleObligationGuard(pi, runtime)
		maybeInjectLifecycleObligationGuard(pi, runtime)
		maybeInjectLifecycleObligationGuard(pi, runtime) // exhausted

		// Stop nudge should still fire on a fresh counter (different mechanism)
		const nudged = maybeInjectFermentStopNudge(pi, runtime)
		expect(nudged).toBe(true)
	})
})
