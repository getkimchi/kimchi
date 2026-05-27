import { afterEach, describe, expect, it, vi } from "vitest"
import type { Ferment, FermentStatus } from "../../ferment/types.js"
import { notifyFermentActive } from "../permissions/index.js"
import { setActive } from "./state.js"

vi.mock("../permissions/index.js", () => ({
	notifyFermentActive: vi.fn(),
}))

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
	vi.mocked(notifyFermentActive).mockClear()
	Reflect.deleteProperty(process.env, "KIMCHI_ACTIVE_FERMENT")
})

describe("setActive", () => {
	it("elevates permissions for draft ferments after the user starts a ferment", () => {
		setActive(makeFerment("draft"))

		expect(notifyFermentActive).toHaveBeenLastCalledWith(true)
		expect(process.env.KIMCHI_ACTIVE_FERMENT).toBe("ferment-draft")
	})

	it("elevates permissions for active ferment states", () => {
		for (const status of ["draft", "planned", "running", "paused"] as const) {
			setActive(makeFerment(status))

			expect(notifyFermentActive).toHaveBeenLastCalledWith(true)
			expect(process.env.KIMCHI_ACTIVE_FERMENT).toBe(`ferment-${status}`)
		}
	})

	it("does not elevate permissions for terminal states", () => {
		for (const status of ["complete", "abandoned"] as const) {
			setActive(makeFerment(status))

			expect(notifyFermentActive).toHaveBeenLastCalledWith(false)
			expect(process.env.KIMCHI_ACTIVE_FERMENT).toBeUndefined()
		}
	})
})
