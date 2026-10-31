import { matchesKey } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SIDE_CHAT_SHORTCUTS, sideChatFocusHint } from "./shortcuts.js"

const keyboardCapabilityMock = vi.hoisted(() => ({ kittySupport: undefined as boolean | undefined }))
vi.mock("../terminal-compat/keyboard-capability.js", () => ({
	getKittyKeyboardSupport: () => keyboardCapabilityMock.kittySupport,
}))

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

describe("sideChatFocusHint", () => {
	afterEach(() => {
		keyboardCapabilityMock.kittySupport = undefined
	})

	it.each([undefined, true])("advertises the focus keys when Kitty keyboard support is %s", (support) => {
		keyboardCapabilityMock.kittySupport = support

		expect(sideChatFocusHint()).toBe("ctrl+alt+←/→")
	})

	it("hides the focus keys on terminals without the Kitty keyboard protocol", () => {
		keyboardCapabilityMock.kittySupport = false

		expect(sideChatFocusHint()).toBeUndefined()
	})
})
