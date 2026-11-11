import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerUnsolicitedRunReason, takePendingRunReason } from "./run-reason-registry.js"

describe("run-reason registry", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		// Clear any leftover from an earlier test in the same process.
		takePendingRunReason()
	})

	afterEach(() => {
		takePendingRunReason()
		vi.useRealTimers()
	})

	it("returns the registered reason exactly once, then falls back", () => {
		registerUnsolicitedRunReason("background-task-complete")
		expect(takePendingRunReason()).toBe("background-task-complete")
		expect(takePendingRunReason()).toBe("agent-initiated")
	})

	it("falls back to agent-initiated when nothing was registered", () => {
		expect(takePendingRunReason()).toBe("agent-initiated")
	})

	it("discards a reason older than the TTL (stale suppressed wake)", () => {
		registerUnsolicitedRunReason("background-task-complete")
		vi.advanceTimersByTime(6_000)
		expect(takePendingRunReason()).toBe("agent-initiated")
	})

	it("keeps a reason inside the TTL", () => {
		registerUnsolicitedRunReason("background-task-complete")
		vi.advanceTimersByTime(4_999)
		expect(takePendingRunReason()).toBe("background-task-complete")
	})
})
