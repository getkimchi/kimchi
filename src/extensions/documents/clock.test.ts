// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { describe, expect, it } from "vitest"
import { createPinnedClock, RealClock } from "./clock.js"

describe("clock seam", () => {
	it("RealClock advances in time and emits random ids", () => {
		expect(RealClock.now()).toBeInstanceOf(Date)
		expect(RealClock.id()).toHaveLength(32)
		expect(RealClock.id()).not.toBe(RealClock.id())
	})
	it("pinned clock is fully deterministic", () => {
		const clock = createPinnedClock()
		expect(clock.now().toISOString()).toBe("1980-01-01T00:00:00.000Z")
		expect(clock.id()).toBe("0000000000000000")
		// Repeated calls give the same instant (no hidden advance).
		expect(clock.now().toISOString()).toBe("1980-01-01T00:00:00.000Z")
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
