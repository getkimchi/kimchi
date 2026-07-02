import { beforeEach, describe, expect, it } from "vitest"
import { clearAllDeclined, clearDeclined, isDeclined, markDeclined } from "./offer-decline-store.js"

beforeEach(() => {
	// Reset module-level state so each test starts from a clean slate.
	clearAllDeclined()
})

describe("offer-decline-store", () => {
	describe("isDeclined", () => {
		it("returns false for an unknown session", () => {
			expect(isDeclined("session-unknown")).toBe(false)
		})

		it("returns true after markDeclined sets the flag", () => {
			const sessionId = "session-marked"
			markDeclined(sessionId)
			expect(isDeclined(sessionId)).toBe(true)
		})
	})

	describe("markDeclined", () => {
		it("is idempotent — marking twice still reports declined once", () => {
			const sessionId = "session-idempotent"
			markDeclined(sessionId)
			markDeclined(sessionId)
			expect(isDeclined(sessionId)).toBe(true)
		})
	})

	describe("clearDeclined", () => {
		it("clears one session's flag", () => {
			const sessionId = "session-clear-one"
			markDeclined(sessionId)
			expect(isDeclined(sessionId)).toBe(true)

			clearDeclined(sessionId)
			expect(isDeclined(sessionId)).toBe(false)
		})

		it("is a no-op for an unknown session (does not throw)", () => {
			expect(() => clearDeclined("session-never-marked")).not.toThrow()
		})
	})

	describe("clearAllDeclined", () => {
		it("clears all sessions' flags", () => {
			markDeclined("session-a")
			markDeclined("session-b")
			markDeclined("session-c")

			clearAllDeclined()

			expect(isDeclined("session-a")).toBe(false)
			expect(isDeclined("session-b")).toBe(false)
			expect(isDeclined("session-c")).toBe(false)
		})
	})

	describe("session independence", () => {
		it("declining one session does not affect other sessions", () => {
			markDeclined("session-a")

			expect(isDeclined("session-a")).toBe(true)
			expect(isDeclined("session-b")).toBe(false)

			// Marking the second session independently.
			markDeclined("session-b")
			expect(isDeclined("session-b")).toBe(true)
			expect(isDeclined("session-a")).toBe(true) // still declined

			// Clearing the first leaves the second intact.
			clearDeclined("session-a")
			expect(isDeclined("session-a")).toBe(false)
			expect(isDeclined("session-b")).toBe(true)
		})
	})
})
