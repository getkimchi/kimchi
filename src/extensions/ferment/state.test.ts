import { afterEach, describe, expect, it, vi } from "vitest"
import type { Ferment, FermentStatus } from "../../ferment/types.js"
import {
	clearActiveFermentId,
	clearCompactionInFlight,
	clearFermentState,
	clearPendingCompaction,
	getActiveFermentId,
	getPendingCompaction,
	hasActiveFerment,
	isCompactionInFlight,
	markCompactionInFlight,
	onActiveFermentChange,
	setActive,
	setPendingCompaction,
} from "./state.js"

const NOW = "2026-01-01T00:00:00.000Z"

function makeFerment(status: FermentStatus): Ferment {
	return {
		id: `ferment-${status}`,
		name: `${status} ferment`,
		status,
		worktree: { path: "/repo" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: NOW,
		updatedAt: NOW,
	}
}

afterEach(() => {
	setActive(undefined)
	vi.unstubAllEnvs()
	clearActiveFermentId()
})

describe("setActive", () => {
	it("elevates permissions for active ferment states", () => {
		const notifyFermentActive = vi.fn()
		onActiveFermentChange(notifyFermentActive)

		for (const status of ["draft", "planned", "running", "paused"] as const) {
			setActive(makeFerment(status))

			expect(notifyFermentActive).toHaveBeenLastCalledWith(true)
			expect(getActiveFermentId()).toBe(`ferment-${status}`)
		}
	})

	it("does not elevate permissions for terminal states", () => {
		const notifyFermentActive = vi.fn()
		onActiveFermentChange(notifyFermentActive)

		for (const status of ["complete", "abandoned"] as const) {
			setActive(makeFerment(status))

			expect(notifyFermentActive).toHaveBeenLastCalledWith(false)
			expect(getActiveFermentId()).toBeUndefined()
		}
	})
})

describe("active ferment env helpers", () => {
	it("treats a non-empty env value as active", () => {
		vi.stubEnv("KIMCHI_ACTIVE_FERMENT", "ferment-123")

		expect(getActiveFermentId()).toBe("ferment-123")
		expect(hasActiveFerment()).toBe(true)
	})

	it("treats missing or blank env values as inactive", () => {
		expect(getActiveFermentId({})).toBeUndefined()
		expect(hasActiveFerment({ KIMCHI_ACTIVE_FERMENT: " " })).toBe(false)
	})
})

describe("clearFermentState", () => {
	afterEach(() => {
		clearPendingCompaction("ferment-A")
		clearPendingCompaction("ferment-B")
		clearCompactionInFlight("ferment-A")
		clearCompactionInFlight("ferment-B")
	})

	it("clears pending compactions and in-flight markers scoped to the ferment", () => {
		setPendingCompaction("ferment-A", {
			kind: "step",
			fermentId: "ferment-A",
			phaseId: "phase-1",
			stepId: "step-1",
			completedAt: NOW,
		})
		setPendingCompaction("ferment-B", {
			kind: "phase",
			fermentId: "ferment-B",
			phaseId: "phase-1",
			completedAt: NOW,
		})
		markCompactionInFlight("ferment-A")

		expect(getPendingCompaction("ferment-A")).toBeDefined()
		expect(isCompactionInFlight("ferment-A")).toBe(true)

		clearFermentState("ferment-A")

		expect(getPendingCompaction("ferment-A")).toBeUndefined()
		expect(isCompactionInFlight("ferment-A")).toBe(false)
		// Other ferments are unaffected.
		expect(getPendingCompaction("ferment-B")).toBeDefined()
	})
})
