import { describe, expect, it } from "vitest"
import {
	_resetSessionSystemPromptStore,
	getSessionSystemPrompt,
	markSessionSystemPromptEnded,
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

	it("marks a session ended without dropping its capture", () => {
		_resetSessionSystemPromptStore()
		recordSessionSystemPrompt("s1", "prompt")
		markSessionSystemPromptEnded("s1")

		expect(getSessionSystemPrompt("s1")).toBe("prompt")
	})

	it("a re-record after shutdown revives the entry", () => {
		_resetSessionSystemPromptStore()
		recordSessionSystemPrompt("s1", "prompt")
		markSessionSystemPromptEnded("s1")
		recordSessionSystemPrompt("s1", "revived prompt")

		// Revived: a live session's capture must not be evictable.
		for (let i = 0; i < 64; i++) {
			recordSessionSystemPrompt(`filler-${i}`, `filler ${i}`)
			markSessionSystemPromptEnded(`filler-${i}`)
		}
		recordSessionSystemPrompt("overflow", "overflow prompt")

		expect(getSessionSystemPrompt("s1")).toBe("revived prompt")
	})
})

describe("session system prompt store eviction", () => {
	it("evicts ended entries oldest-first beyond the cap", () => {
		_resetSessionSystemPromptStore()
		for (let i = 0; i < 64; i++) {
			recordSessionSystemPrompt(`s${i}`, `prompt ${i}`)
			markSessionSystemPromptEnded(`s${i}`)
		}
		expect(getSessionSystemPrompt("s0")).toBe("prompt 0")

		recordSessionSystemPrompt("s64", "prompt 64")

		expect(getSessionSystemPrompt("s0")).toBeUndefined()
		expect(getSessionSystemPrompt("s1")).toBe("prompt 1")
		expect(getSessionSystemPrompt("s64")).toBe("prompt 64")
	})

	it("never evicts a live session's capture — grows past the cap instead", () => {
		_resetSessionSystemPromptStore()
		for (let i = 0; i < 80; i++) {
			recordSessionSystemPrompt(`live${i}`, `prompt ${i}`)
		}

		// Every session is still live: nothing may be dropped, even though the
		// store is over its soft cap. Evicting here would resurrect the very bug
		// this store exists to fix (exports falling back to pi's base prompt).
		for (let i = 0; i < 80; i++) {
			expect(getSessionSystemPrompt(`live${i}`)).toBe(`prompt ${i}`)
		}
	})

	it("prefers evicting the oldest ended entry over a newer live one", () => {
		_resetSessionSystemPromptStore()
		recordSessionSystemPrompt("old-ended", "old prompt")
		markSessionSystemPromptEnded("old-ended")
		for (let i = 0; i < 64; i++) {
			recordSessionSystemPrompt(`live${i}`, `prompt ${i}`)
		}

		recordSessionSystemPrompt("overflow", "overflow prompt")

		// The old ended entry is evictable; none of the live ones are.
		expect(getSessionSystemPrompt("old-ended")).toBeUndefined()
		for (let i = 0; i < 64; i++) {
			expect(getSessionSystemPrompt(`live${i}`)).toBe(`prompt ${i}`)
		}
		expect(getSessionSystemPrompt("overflow")).toBe("overflow prompt")
	})

	it("a re-record refreshes the eviction position", () => {
		_resetSessionSystemPromptStore()
		recordSessionSystemPrompt("old", "old prompt")
		markSessionSystemPromptEnded("old")
		for (let i = 0; i < 63; i++) {
			recordSessionSystemPrompt(`s${i}`, `prompt ${i}`)
			markSessionSystemPromptEnded(`s${i}`)
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
