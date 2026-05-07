import { describe, expect, it } from "vitest"
import { computeIdleSeconds, getStateFilePath } from "./index.js"
import { DEFAULT_CURATOR_STATE } from "./state.js"
import type { CuratorState } from "./state.js"

describe("getStateFilePath", () => {
	it("returns .curator_state.json inside skillsDir", () => {
		expect(getStateFilePath("/home/user/.config/kimchi/harness/skills")).toBe(
			"/home/user/.config/kimchi/harness/skills/.curator_state.json",
		)
	})
})

describe("computeIdleSeconds", () => {
	it("returns Infinity when last_session_ended_at is undefined", () => {
		const state: CuratorState = { ...DEFAULT_CURATOR_STATE }
		expect(computeIdleSeconds(state, new Date("2026-05-07T12:00:00Z"))).toBe(Number.POSITIVE_INFINITY)
	})

	it("returns correct seconds since last session ended", () => {
		const now = new Date("2026-05-07T12:00:00Z")
		const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000).toISOString()
		const state: CuratorState = { ...DEFAULT_CURATOR_STATE, last_session_ended_at: twoHoursAgo }
		const result = computeIdleSeconds(state, now)
		expect(result).toBeCloseTo(7200, -1)
	})

	it("returns 0 when last_session_ended_at is now", () => {
		const now = new Date("2026-05-07T12:00:00Z")
		const state: CuratorState = { ...DEFAULT_CURATOR_STATE, last_session_ended_at: now.toISOString() }
		expect(computeIdleSeconds(state, now)).toBeCloseTo(0, 0)
	})
})
