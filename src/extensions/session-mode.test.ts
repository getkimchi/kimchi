import { describe, expect, it } from "vitest"
import { getSessionMode, setSessionMode } from "./session-mode.js"

describe("session-mode", () => {
	it("set/get round-trip returns the stored mode", () => {
		setSessionMode("test-session", "orchestrator")
		expect(getSessionMode("test-session")).toBe("orchestrator")
	})

	it("returns undefined for an unknown sessionId", () => {
		expect(getSessionMode("unknown-session")).toBeUndefined()
	})

	it("getSessionMode(undefined) returns undefined", () => {
		expect(getSessionMode(undefined)).toBeUndefined()
	})

	it("setSessionMode(undefined, ...) is a no-op", () => {
		setSessionMode(undefined, "orchestrator")
		expect(getSessionMode(undefined)).toBeUndefined()
	})

	it("stores different modes per session independently", () => {
		setSessionMode("test-session", "orchestrator")
		setSessionMode("other-session", "single")
		expect(getSessionMode("test-session")).toBe("orchestrator")
		expect(getSessionMode("other-session")).toBe("single")
	})

	it("overwrites an existing mode for the same sessionId", () => {
		setSessionMode("test-session", "orchestrator")
		setSessionMode("test-session", "single")
		expect(getSessionMode("test-session")).toBe("single")
	})
})
