import { CURSOR_MARKER, stripTerminalSequences } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { testTheme } from "../__mocks__/theme.js"
import { applyFocusChrome, type DecoratableEditor } from "./focus-chrome.js"

const FAKE_CURSOR = "\x1b_pi:fc\x07█\x1b_pi:/fc\x07"

class FakeEditor implements DecoratableEditor {
	focused = false
	borderColor = (text: string) => text
	render(width: number): string[] {
		return [
			this.borderColor("─".repeat(width)),
			`> hi${CURSOR_MARKER}${FAKE_CURSOR}`,
			this.borderColor("─".repeat(width)),
		]
	}
}

describe("applyFocusChrome", () => {
	it("labels the focused editor with a heavy border and keeps its cursor", () => {
		const editor = new FakeEditor()
		editor.focused = true
		applyFocusChrome(editor, testTheme, { label: "main" })

		const [top, body, bottom] = editor.render(20)

		expect(stripTerminalSequences(top)).toBe(`━━ ● main ${"━".repeat(10)}`)
		expect(body).toContain(CURSOR_MARKER)
		expect(stripTerminalSequences(bottom)).toBe("━".repeat(20))
	})

	it("dims the unfocused editor and drops both cursors", () => {
		const editor = new FakeEditor()
		applyFocusChrome(editor, testTheme, { label: "side chat" })

		const [top, body] = editor.render(24)

		expect(stripTerminalSequences(top)).toBe(`── ○ side chat ${"─".repeat(9)}`)
		expect(body).not.toContain(CURSOR_MARKER)
		expect(body).not.toContain("\x1b_pi:fc")
	})

	it("leaves the border unlabelled when the editor is too narrow", () => {
		const editor = new FakeEditor()
		applyFocusChrome(editor, testTheme, { label: "side chat" })

		expect(stripTerminalSequences(editor.render(8)[0])).toBe("─".repeat(8))
	})

	it("restores the editor exactly, including a border colour set while decorated", () => {
		const editor = new FakeEditor()
		const original = editor.render
		const restore = applyFocusChrome(editor, testTheme, { label: "main" })
		const replacement = (text: string) => `[${text}]`
		editor.borderColor = replacement

		restore()

		expect(editor.render).toBe(original)
		expect(Object.hasOwn(editor, "render")).toBe(false)
		expect(editor.borderColor).toBe(replacement)
	})
})
