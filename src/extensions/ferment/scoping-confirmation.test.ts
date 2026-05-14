import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { confirmPendingScope } from "./scoping-confirmation.js"

function createRuntime(): { runtime: FermentRuntime; storage: FermentEventStore } {
	const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-scope-confirm-test-")))
	const runtime = { ...createDefaultFermentRuntime(), getStorage: () => storage }
	return { runtime, storage }
}

describe("confirmPendingScope", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it("applies pending scope exactly once and clears the pending buffer", () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("Confirm")
		runtime.setPendingScope(ferment.id, {
			goal: "Goal",
			successCriteria: "Works",
			constraints: ["no regressions"],
			phases: [{ name: "P1", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		const first = confirmPendingScope(runtime, ferment.id, undefined, "turn_end", "Confirmed Title")
		const second = confirmPendingScope(runtime, ferment.id, undefined, "turn_end", "Confirmed Title")

		expect(first.ok).toBe(true)
		if (first.ok) {
			expect(first.outcome.ferment.name).toBe("Confirmed Title")
			expect(first.outcome.ferment.status).toBe("planned")
			expect(first.outcome.ferment.phases).toHaveLength(1)
		}
		expect(second.ok).toBe(false)
		if (!second.ok) expect(second.error.code).toBe("MISSING_PENDING_SCOPE")
		expect(runtime.getPendingScope(ferment.id)).toBeUndefined()
		expect(storage.get(ferment.id)?.phases).toHaveLength(1)
	})

	it("uses explicit phases from propose_phases and preserves pending user answers", () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("Explicit")
		runtime.setPendingScope(ferment.id, {
			goal: "User goal",
			successCriteria: "User criteria",
			constraints: ["user constraint"],
		})

		const result = confirmPendingScope(
			runtime,
			ferment.id,
			[{ name: "P1", goal: "Build", steps: [{ description: "Do it" }] }],
			"propose_phases",
		)

		expect(result.ok).toBe(true)
		const saved = storage.get(ferment.id)
		expect(saved?.goal).toBe("User goal")
		expect(saved?.successCriteria).toBe("User criteria")
		expect(saved?.constraints).toEqual(["user constraint"])
		expect(saved?.phases[0]?.name).toBe("P1")
	})

	it("rejects missing pending scope or missing phases without mutating", () => {
		const { runtime, storage } = createRuntime()
		const missing = confirmPendingScope(runtime, "missing", undefined, "turn_end")
		expect(missing.ok).toBe(false)
		if (!missing.ok) expect(missing.error.code).toBe("MISSING_PENDING_SCOPE")

		const ferment = storage.create("No Phases")
		runtime.setPendingScope(ferment.id, { goal: "Goal", successCriteria: "Works", constraints: [] })
		const empty = confirmPendingScope(runtime, ferment.id, undefined, "turn_end")

		expect(empty.ok).toBe(false)
		if (!empty.ok) expect(empty.error.code).toBe("MISSING_PENDING_PHASES")
		expect(storage.get(ferment.id)?.status).toBe("draft")
		expect(runtime.getPendingScope(ferment.id)).toBeDefined()
	})
})
