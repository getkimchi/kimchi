import { describe, expect, it } from "vitest"
import { sideChatAutocomplete } from "./autocomplete.js"

const CWD = "/tmp/side-chat"

/** Slash-command suggestions for `text` (single-line editor, cursor at end). */
async function slashSuggestions(mode: "chat" | "wrapping" | "review", text: string) {
	const provider = sideChatAutocomplete(mode, CWD)
	const suggestions = await provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal })
	return suggestions?.items.map((item) => item.value)
}

describe("sideChatAutocomplete", () => {
	it("hints only the side-chat commands, not the main session's", async () => {
		expect(await slashSuggestions("chat", "/")).toEqual(["wrap", "close"])
	})

	it("narrows by the typed prefix", async () => {
		expect(await slashSuggestions("chat", "/c")).toEqual(["close"])
		expect(await slashSuggestions("chat", "/wr")).toEqual(["wrap"])
	})

	it("carries a description with each hint", async () => {
		const provider = sideChatAutocomplete("chat", CWD)
		const suggestions = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal })
		for (const item of suggestions?.items ?? []) {
			expect(item.description).toBeTruthy()
		}
	})

	it.each(["wrapping" as const, "review" as const])("hides /wrap when it cannot run (%s mode)", async (mode) => {
		expect(await slashSuggestions(mode, "/")).toEqual(["close"])
	})

	it("does not hint slash commands mid-sentence", async () => {
		// A mid-sentence "/" is a path prefix, not a command — the provider may
		// offer filesystem entries (like the main editor), never wrap/close.
		const items = (await slashSuggestions("chat", "why /")) ?? []
		expect(items).not.toContain("wrap")
		expect(items).not.toContain("close")
	})
})
