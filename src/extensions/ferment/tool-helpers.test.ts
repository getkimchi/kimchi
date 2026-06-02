import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
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
})
