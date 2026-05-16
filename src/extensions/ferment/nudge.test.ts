import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import {
	injectResumeAutoNudge,
	maybeInjectReactiveAutoNudge,
	onStepCompleted,
	resetAllReactiveAutoNudgeCounts,
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
		mode: "plan",
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
	resetAllReactiveAutoNudgeCounts()
})

describe("ferment nudges", () => {
	it("reads active and auto-mode state from the injected runtime", () => {
		const pi = createPi()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActive: () => makeDraftFerment(),
			isAutoModeEnabled: () => true,
		}

		injectResumeAutoNudge(pi, runtime)

		expect(pi.appendEntry).toHaveBeenCalledWith(
			"ferment_breadcrumb",
			expect.objectContaining({ text: expect.stringContaining('Resume [scope]: "Injected Nudge"') }),
		)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_automode_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("RESUMING ferment after /auto") })],
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		)
	})

	it("syncs active state from injected storage on step completion", () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-nudge-test-")))
		const setActiveSpy = vi.fn()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			getActiveId: () => "ferment-1",
			setActive: setActiveSpy,
			isAutoModeEnabled: () => false,
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
			isAutoModeEnabled: () => true,
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
		const mode = applyAndPersist(draft.id, { type: "set_mode", mode: "exec" })
		if (!mode.ok) throw new Error(mode.error.message)
		runtime.getActiveId = () => draft.id

		maybeInjectReactiveAutoNudge(pi, runtime)

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_automode_nudge",
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
			isAutoModeEnabled: () => true,
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

		maybeInjectReactiveAutoNudge(pi, runtime)

		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(setActiveSpy).toHaveBeenCalledWith(undefined)
	})

	it("suppresses repeated reactive nudges after the loop guard cap", () => {
		const pi = createPi()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActive: () =>
				makeDraftFerment({
					status: "planned",
					mode: "exec",
					phases: [{ id: "phase-1", index: 1, name: "Phase", goal: "Build", status: "planned", steps: [] }],
				}),
			getActiveId: () => "ferment-1",
			getStorage: () =>
				({
					get: () =>
						makeDraftFerment({
							status: "planned",
							mode: "exec",
							phases: [{ id: "phase-1", index: 1, name: "Phase", goal: "Build", status: "planned", steps: [] }],
						}),
				}) as unknown as FermentRuntime["getStorage"] extends () => infer T ? T : never,
			isAutoModeEnabled: () => true,
		}

		maybeInjectReactiveAutoNudge(pi, runtime)
		maybeInjectReactiveAutoNudge(pi, runtime)
		maybeInjectReactiveAutoNudge(pi, runtime)
		maybeInjectReactiveAutoNudge(pi, runtime)

		expect(pi.sendMessage).toHaveBeenCalledTimes(3)
		expect(pi.appendEntry).toHaveBeenLastCalledWith(
			"ferment_breadcrumb",
			expect.objectContaining({ text: expect.stringContaining("Auto-nudge suppressed after 3") }),
		)
	})

	it("prunes the reactive loop guard when a ferment is paused", () => {
		const pi = createPi()
		let current = makeDraftFerment({
			status: "planned",
			mode: "exec",
			phases: [{ id: "phase-1", index: 1, name: "Phase", goal: "Build", status: "planned", steps: [] }],
		})
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActiveId: () => "ferment-1",
			getStorage: () =>
				({
					get: () => current,
				}) as unknown as FermentRuntime["getStorage"] extends () => infer T ? T : never,
			isAutoModeEnabled: () => true,
		}

		maybeInjectReactiveAutoNudge(pi, runtime)
		maybeInjectReactiveAutoNudge(pi, runtime)
		maybeInjectReactiveAutoNudge(pi, runtime)
		current = { ...current, status: "paused" }
		maybeInjectReactiveAutoNudge(pi, runtime)
		current = { ...current, status: "planned" }
		maybeInjectReactiveAutoNudge(pi, runtime)

		expect(pi.sendMessage).toHaveBeenCalledTimes(4)
	})

	it("nudges failed phase recovery with retry and bypass actions", () => {
		const pi = createPi()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActive: () =>
				makeDraftFerment({
					status: "planned",
					phases: [{ id: "phase-1", index: 1, name: "Phase", goal: "Build", status: "failed", steps: [] }],
				}),
			isAutoModeEnabled: () => true,
		}

		injectResumeAutoNudge(pi, runtime)

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: [
					expect.objectContaining({
						text: expect.stringContaining(
							"call activate_ferment_phase to retry, call skip_ferment_phase to bypass, or ask the user to run /ferment abandon",
						),
					}),
				],
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		)
	})
})
