import { matchesKey } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { SIDE_CHAT_SHORTCUTS } from "./shortcuts.js"

describe("SIDE_CHAT_SHORTCUTS", () => {
	// Terminals send modified arrows as xterm CSI sequences even when Option
	// is a compose key, which is why focus doesn't use alt+digits.
	it.each([
		{ binding: SIDE_CHAT_SHORTCUTS.focusMain, sequence: "\x1b[1;7D" },
		{ binding: SIDE_CHAT_SHORTCUTS.focusSide, sequence: "\x1b[1;7C" },
	])("$binding matches what the terminal sends", ({ binding, sequence }) => {
		expect(matchesKey(sequence, binding)).toBe(true)
	})

	it("does not take the editor's word-movement keys", () => {
		for (const sequence of ["\x1b[1;3D", "\x1b[1;5D", "\x1bb"]) {
			expect(matchesKey(sequence, SIDE_CHAT_SHORTCUTS.focusMain)).toBe(false)
		}
	})
})
