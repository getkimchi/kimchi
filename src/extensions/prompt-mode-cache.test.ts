import { describe, expect, it } from "vitest"
import { forgetPromptMode, getPromptMode, setPromptMode } from "./prompt-mode-cache.js"

describe("prompt-mode-cache", () => {
	it("set/get round-trip returns the stored mode", () => {
		setPromptMode("test-session", "orchestrator")
		expect(getPromptMode("test-session")).toBe("orchestrator")
	})

	it("returns undefined for an unknown sessionId", () => {
		expect(getPromptMode("unknown-session")).toBeUndefined()
	})

	it("getPromptMode(undefined) returns undefined", () => {
		expect(getPromptMode(undefined)).toBeUndefined()
	})

	it("setPromptMode(undefined, ...) is a no-op", () => {
		setPromptMode(undefined, "orchestrator")
		expect(getPromptMode(undefined)).toBeUndefined()
	})

	it("stores different modes per session independently", () => {
		setPromptMode("test-session", "orchestrator")
		setPromptMode("other-session", "single")
		expect(getPromptMode("test-session")).toBe("orchestrator")
		expect(getPromptMode("other-session")).toBe("single")
	})

	it("overwrites an existing mode for the same sessionId", () => {
		setPromptMode("test-session", "orchestrator")
		setPromptMode("test-session", "single")
		expect(getPromptMode("test-session")).toBe("single")
	})

	it("forgetPromptMode drops only the given session", () => {
		setPromptMode("forget-me", "single")
		setPromptMode("keep-me", "orchestrator")

		forgetPromptMode("forget-me")

		expect(getPromptMode("forget-me")).toBeUndefined()
		expect(getPromptMode("keep-me")).toBe("orchestrator")
	})

	it("forgetPromptMode(undefined) is a no-op", () => {
		expect(() => forgetPromptMode(undefined)).not.toThrow()
	})
})
