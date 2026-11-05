import { describe, expect, it } from "vitest"
import {
	_resetSessionSystemPromptStore,
	getSessionSystemPrompt,
	recordSessionSystemPrompt,
	resolveExportSystemPrompt,
} from "./session-system-prompt-store.js"

describe("session system prompt store", () => {
	it("round-trips a recorded prompt per session", () => {
		_resetSessionSystemPromptStore()
		recordSessionSystemPrompt("s1", "You are Kimchi.")
		recordSessionSystemPrompt("s2", "You are an explorer.")

		expect(getSessionSystemPrompt("s1")).toBe("You are Kimchi.")
		expect(getSessionSystemPrompt("s2")).toBe("You are an explorer.")
		expect(getSessionSystemPrompt("s3")).toBeUndefined()
	})

	it("overwrites on re-record — the last turn wins", () => {
		_resetSessionSystemPromptStore()
		recordSessionSystemPrompt("s1", "first prompt")
		recordSessionSystemPrompt("s1", "second prompt")

		expect(getSessionSystemPrompt("s1")).toBe("second prompt")
	})

	it("ignores empty prompts", () => {
		_resetSessionSystemPromptStore()
		recordSessionSystemPrompt("s1", "")

		expect(getSessionSystemPrompt("s1")).toBeUndefined()
	})

	it("evicts the oldest session beyond the retention bound", () => {
		_resetSessionSystemPromptStore()
		for (let i = 0; i < 64; i++) {
			recordSessionSystemPrompt(`s${i}`, `prompt ${i}`)
		}
		expect(getSessionSystemPrompt("s0")).toBe("prompt 0")

		recordSessionSystemPrompt("s64", "prompt 64")

		expect(getSessionSystemPrompt("s0")).toBeUndefined()
		expect(getSessionSystemPrompt("s1")).toBe("prompt 1")
		expect(getSessionSystemPrompt("s64")).toBe("prompt 64")
	})

	it("a re-record refreshes the eviction position", () => {
		_resetSessionSystemPromptStore()
		recordSessionSystemPrompt("old", "old prompt")
		for (let i = 0; i < 63; i++) {
			recordSessionSystemPrompt(`s${i}`, `prompt ${i}`)
		}
		// Touch "old" so it is the most recently inserted of the 65 entries.
		recordSessionSystemPrompt("old", "old prompt refreshed")

		recordSessionSystemPrompt("overflow", "overflow prompt")

		expect(getSessionSystemPrompt("old")).toBe("old prompt refreshed")
		expect(getSessionSystemPrompt("s0")).toBeUndefined()
	})
})

describe("resolveExportSystemPrompt", () => {
	it("returns the captured prompt when present", () => {
		_resetSessionSystemPromptStore()
		recordSessionSystemPrompt("s1", "KIMCHI PROMPT")

		expect(resolveExportSystemPrompt("s1", "pi base prompt")).toBe("KIMCHI PROMPT")
	})

	it("falls back to the provided value when nothing was captured", () => {
		_resetSessionSystemPromptStore()

		expect(resolveExportSystemPrompt("s1", "pi base prompt")).toBe("pi base prompt")
	})

	it("returns undefined when neither capture nor fallback exists", () => {
		_resetSessionSystemPromptStore()

		expect(resolveExportSystemPrompt("s1")).toBeUndefined()
		expect(resolveExportSystemPrompt(undefined, "pi base prompt")).toBe("pi base prompt")
		expect(resolveExportSystemPrompt(undefined)).toBeUndefined()
	})

	it("treats a whitespace-only capture as absent", () => {
		_resetSessionSystemPromptStore()
		recordSessionSystemPrompt("s1", "   \n  ")

		expect(resolveExportSystemPrompt("s1", "pi base prompt")).toBe("pi base prompt")
	})

	it("treats a whitespace-only fallback as absent", () => {
		_resetSessionSystemPromptStore()

		expect(resolveExportSystemPrompt("s1", "   ")).toBeUndefined()
	})

	it("never leaks one session's capture into another session's export", () => {
		_resetSessionSystemPromptStore()
		recordSessionSystemPrompt("main", "MAIN PROMPT")
		recordSessionSystemPrompt("sub", "SUB PROMPT")

		expect(resolveExportSystemPrompt("main", "pi base")).toBe("MAIN PROMPT")
		expect(resolveExportSystemPrompt("sub", "pi base")).toBe("SUB PROMPT")
		expect(resolveExportSystemPrompt("other", "pi base")).toBe("pi base")
	})
})
