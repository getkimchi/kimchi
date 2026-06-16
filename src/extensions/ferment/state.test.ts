import { afterEach, describe, expect, it, vi } from "vitest"
import type { Ferment, FermentStatus } from "../../ferment/types.js"
import {
	clearActiveFermentId,
	getActiveFermentId,
	hasActiveFerment,
	onActiveFermentChange,
	setActive,
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

describe("onActiveFermentChange", () => {
	it("supports multiple listeners", () => {
		const listener1 = vi.fn()
		const listener2 = vi.fn()
		const listener3 = vi.fn()

		const unsubscribe1 = onActiveFermentChange(listener1)
		onActiveFermentChange(listener2)
		onActiveFermentChange(listener3)

		setActive(makeFerment("running"))

		expect(listener1).toHaveBeenCalledWith(true)
		expect(listener2).toHaveBeenCalledWith(true)
		expect(listener3).toHaveBeenCalledWith(true)

		// Unsubscribe listener1 and verify others still work
		unsubscribe1()
		setActive(makeFerment("complete"))

		expect(listener1).toHaveBeenCalledTimes(1) // Not called again
		expect(listener2).toHaveBeenCalledTimes(2)
		expect(listener3).toHaveBeenCalledTimes(2)
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
