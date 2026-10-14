import { describe, expect, it } from "vitest"
import { getSessionMemoryOverride, setSessionMemoryOverride } from "./session-toggle.js"

describe("session-toggle", () => {
	it("reads undefined (default) for an unseen session key", () => {
		expect(getSessionMemoryOverride({})).toBeUndefined()
	})

	it("sets and reads an override per session key", () => {
		const a = {}
		const b = {}
		setSessionMemoryOverride(a, false)
		expect(getSessionMemoryOverride(a)).toBe(false)
		// Per-session isolation: b is untouched by a's override.
		expect(getSessionMemoryOverride(b)).toBeUndefined()
	})

	it("overwrites a previous override", () => {
		const key = {}
		setSessionMemoryOverride(key, false)
		setSessionMemoryOverride(key, true)
		expect(getSessionMemoryOverride(key)).toBe(true)
	})

	it("clears the override back to the default with undefined", () => {
		const key = {}
		setSessionMemoryOverride(key, false)
		setSessionMemoryOverride(key, undefined)
		expect(getSessionMemoryOverride(key)).toBeUndefined()
	})

	it("treats distinct object identities as distinct sessions", () => {
		const key1 = { id: 1 }
		const key2 = { id: 1 }
		setSessionMemoryOverride(key1, false)
		expect(getSessionMemoryOverride(key2)).toBeUndefined()
	})
})
