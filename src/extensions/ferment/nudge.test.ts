import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import {
	maybeInjectReactiveContinuationNudge,
	onStepCompleted,
	resetAllReactiveContinuationNudgeCounts,
} from "./nudge.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { getActive, setActive } from "./state.js"
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
			successCriteria: "Works",
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
			successCriteria: "Works",
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		runtime.getActiveId = () => draft.id

		maybeInjectReactiveContinuationNudge(pi, runtime)

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_continuation_nudge",
				content: [expect.objectContaining({ text: "activate_ferment_phase: activate the first planned phase" })],
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
				content: [expect.objectContaining({ text: "activate_ferment_phase: activate the first planned phase" })],
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
			successCriteria: "Works",
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
						text: expect.stringContaining("recover_phase: handle failed phase"),
					}),
				],
				details: expect.objectContaining({ action: "recover_phase" }),
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		)
	})
})
