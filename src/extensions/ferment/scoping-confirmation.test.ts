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
			title: "Confirmed Title",
			goal: "Goal",
			successCriteria: "Works",
			constraints: ["no regressions"],
			phases: [{ name: "P1", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		const first = confirmPendingScope(runtime, ferment.id, undefined, "turn_end")
		const second = confirmPendingScope(runtime, ferment.id, undefined, "turn_end")

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

	it("does not send a hidden continuation nudge after confirmed manual scoping", () => {
		const { runtime, storage } = createRuntime()
		const pi = { appendEntry: vi.fn(), sendMessage: vi.fn() }
		const ferment = storage.create("Confirm And Continue")
		runtime.setPendingScope(ferment.id, {
			title: "Confirmed Title",
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [{ name: "P1", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		const result = confirmPendingScope(runtime, ferment.id, undefined, "turn_end", pi as never)

		expect(result.ok).toBe(true)
		expect(pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_continuation_nudge" }),
			expect.anything(),
		)
	})

	it("emits a visible rename acknowledgement when the confirmed title changes", () => {
		const { runtime, storage } = createRuntime()
		const pi = { appendEntry: vi.fn(), sendMessage: vi.fn() }
		const ferment = storage.create("Draft OAuth Task")
		runtime.setPendingScope(ferment.id, {
			title: "Google OAuth Login",
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [{ name: "P1", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		const result = confirmPendingScope(runtime, ferment.id, undefined, "turn_end", pi as never)

		expect(result.ok).toBe(true)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_ack",
				display: true,
				details: expect.objectContaining({
					text: 'Named ferment "Google OAuth Login" (was "Draft OAuth Task").',
					variant: "ack",
				}),
			}),
			{ triggerTurn: false },
		)
	})

	it("preserves the draft name when the confirmed title is blank", () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("Draft Name")
		runtime.setPendingScope(ferment.id, {
			title: '  ""  ',
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [{ name: "P1", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		const result = confirmPendingScope(runtime, ferment.id, undefined, "turn_end")

		expect(result.ok).toBe(true)
		if (result.ok) expect(result.outcome.ferment.name).toBe("Draft Name")
	})

	it("uses explicit phases from propose_ferment_scoping and preserves pending user answers", () => {
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
			"propose_ferment_scoping",
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

	it("forwards assumptions from pendingScope into the persisted ferment", () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("With Assumptions")
		runtime.setPendingScope(ferment.id, {
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			assumptions: "API rate limits are documented",
			phases: [{ name: "P1", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		const result = confirmPendingScope(runtime, ferment.id, undefined, "turn_end")

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.outcome.ferment.scoping.assumptions?.answer).toBe("API rate limits are documented")
		}
	})

	it("accepts propose_ferment_scoping as a valid source and applies pending scope", () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("Scoping Source Test")
		runtime.setPendingScope(ferment.id, {
			goal: "Build auth",
			successCriteria: "Tests pass",
			constraints: ["no external libs"],
			phases: [{ name: "P1", goal: "Implement OAuth", steps: [{ description: "Add handler" }] }],
		})

		const result = confirmPendingScope(runtime, ferment.id, undefined, "propose_ferment_scoping")

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.outcome.ferment.status).toBe("planned")
			expect(result.outcome.ferment.goal).toBe("Build auth")
		}
		// Pending scope should be cleared after confirmation
		expect(runtime.getPendingScope(ferment.id)).toBeUndefined()
	})

	it("omits assumptions in persisted ferment when pendingScope.assumptions is undefined", () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("No Assumptions")
		runtime.setPendingScope(ferment.id, {
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [{ name: "P1", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		const result = confirmPendingScope(runtime, ferment.id, undefined, "turn_end")

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.outcome.ferment.scoping.assumptions).toBeUndefined()
		}
	})
})
