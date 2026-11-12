import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	clearPendingRunReasonsForTest,
	registerUnsolicitedRunReason,
	takePendingRunReason,
} from "./run-reason-registry.js"

describe("run-reason registry", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		clearPendingRunReasonsForTest()
	})

	afterEach(() => {
		clearPendingRunReasonsForTest()
		vi.useRealTimers()
	})

	it("returns the registered reason exactly once, then falls back", () => {
		registerUnsolicitedRunReason("s1", "background-task-complete")
		expect(takePendingRunReason("s1")).toBe("background-task-complete")
		expect(takePendingRunReason("s1")).toBe("agent-initiated")
	})

	it("falls back to agent-initiated when nothing was registered", () => {
		expect(takePendingRunReason("s1")).toBe("agent-initiated")
	})

	it("discards a reason older than the TTL (stale suppressed wake)", () => {
		registerUnsolicitedRunReason("s1", "background-task-complete")
		vi.advanceTimersByTime(6_000)
		expect(takePendingRunReason("s1")).toBe("agent-initiated")
	})

	it("keeps a reason inside the TTL", () => {
		registerUnsolicitedRunReason("s1", "background-task-complete")
		vi.advanceTimersByTime(4_999)
		expect(takePendingRunReason("s1")).toBe("background-task-complete")
	})

	it("isolates reasons per session (registration and consumption have awaited run setup between them)", () => {
		// Regression: the pre-keying single slot let ANY session's agent_start
		// consume the reason — pi yields between registerUnsolicitedRunReason
		// and the wake's agent_start (sendMessage awaits run setup), so a
		// prompt-owned start in another session discarded it and the wake run
		// fell back to the generic label.
		registerUnsolicitedRunReason("wake-session", "background-task-complete")
		expect(takePendingRunReason("other-session")).toBe("agent-initiated")
		expect(takePendingRunReason("wake-session")).toBe("background-task-complete")
	})
})
