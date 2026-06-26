import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { type EditorTheme, type TUI, visibleWidth } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PromptEditor } from "./editor.js"

// Minimal stubs that satisfy what the upstream Editor constructor and our
// `PromptEditor.render` actually touch. Anything not listed here is unused by
// the render path; the cast at the bottom keeps the typechecker honest.

function makeTui(): TUI {
	const tui = {
		requestRender: vi.fn(),
		terminal: { rows: 40, cols: 80 },
	} as unknown as TUI
	return tui
}

function makeEditorTheme(): EditorTheme {
	return {
		borderColor: (s: string) => s,
		selectList: {} as EditorTheme["selectList"],
	}
}

function makeKeybindings(): KeybindingsManager {
	return {
		matches: (_data: string, _action: string) => false,
	} as unknown as KeybindingsManager
}

function makeTheme(): Theme {
	// Stub: only `getFgAnsi` is touched by PromptEditor.render. Cast keeps the
	// typechecker honest while letting us return plain ANSI escapes.
	return {
		getFgAnsi: (_color: string) => "",
	} as unknown as Theme
}

function makeEditor(): { editor: PromptEditor; tui: TUI } {
	const tui = makeTui()
	const editor = new PromptEditor(tui, makeEditorTheme(), makeKeybindings(), makeTheme())
	return { editor, tui }
}

// Strip ANSI escape codes for assertions.
// biome-ignore lint/suspicious/noControlCharactersInRegex: test-only helper
const ANSI_RE = /\x1b\[[0-9;]*m/g
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "")
}

describe("PromptEditor", () => {
	describe("render — no indicator", () => {
		it("renders top border, single content row, bottom border when empty", () => {
			const { editor } = makeEditor()
			const lines = editor.render(80).map(stripAnsi)
			expect(lines).toHaveLength(3)
			expect(lines[0].startsWith("─")).toBe(true)
			expect(lines[1].startsWith("❯")).toBe(true)
			expect(lines[2].startsWith("─")).toBe(true)
		})

		it("hides the placeholder when the editor is too narrow to fit it", () => {
			const { editor } = makeEditor()
			const lines = editor.render(8).map(stripAnsi)
			// Even at 8 cols we still expect top border, content row, bottom border.
			expect(lines).toHaveLength(3)
			expect(lines[1].startsWith("❯")).toBe(true)
			// Placeholder text is intentionally long; on a 8-col terminal it
			// must be dropped entirely rather than truncated mid-word.
			expect(lines[1]).not.toContain("ask anything")
		})
	})

	describe("render — with indicator", () => {
		let editor: PromptEditor

		beforeEach(() => {
			editor = makeEditor().editor
			editor.setPendingImageIndicator("Image in clipboard · ctrl+v to paste")
		})

		afterEach(() => {
			editor.setPendingImageIndicator(null)
		})

		it("inserts the indicator row between the top border and the content row", () => {
			const lines = editor.render(80).map(stripAnsi)
			// Empty editor with indicator: top border, indicator row, content row, bottom border.
			expect(lines).toHaveLength(4)
			expect(lines[0].startsWith("─")).toBe(true)
			expect(lines[1]).toContain("Image in clipboard")
			expect(lines[2].startsWith("❯")).toBe(true)
			expect(lines[3].startsWith("─")).toBe(true)
		})

		it("right-aligns the indicator row", () => {
			const lines = editor.render(80).map(stripAnsi)
			const indicatorRow = lines[1]
			// "Image in clipboard · ctrl+v to paste" is 36 visible cells; right
			// edge must end with that text.
			expect(indicatorRow.endsWith("Image in clipboard · ctrl+v to paste")).toBe(true)
		})

		it("does NOT squeeze the editor body when the indicator is set", () => {
			// This is the regression: previously the editor was rendered at
			// contentWidth − 36 − 1, squeezing user input into a narrow strip.
			// After the fix, the editor body uses the full contentWidth.
			editor.setText("fix the bug in the user authentication system today please")
			const lines = editor.render(60).map(stripAnsi)
			const contentWidth = 60 - 2 // CHEVRON_WIDTH
			// Find the first content row (cursor row).
			const cursorRow = lines.find((l) => l.startsWith("❯"))
			expect(cursorRow).toBeDefined()
			const cursorRowWidth = visibleWidth(cursorRow ?? "")
			// The cursor row should span the full content width (minus the
			// chevron prefix), not the previous squeezed width of ~21.
			expect(cursorRowWidth).toBeGreaterThan(contentWidth / 2)
		})

		it("truncates the indicator with ellipsis when it does not fit the width", () => {
			const lines = editor.render(20).map(stripAnsi)
			// Find the indicator row — it sits between the top and bottom borders.
			const indicatorRow = lines[1]
			expect(indicatorRow).toBeDefined()
			// No overflow: row is at most 20 cells wide.
			expect(visibleWidth(indicatorRow)).toBeLessThanOrEqual(20)
			// Truncation marker present (truncateToWidth appends "...").
			expect(indicatorRow).toContain("...")
		})
	})

	describe("render — indicator lifecycle", () => {
		it("produces 3 rows (no indicator row) after setPendingImageIndicator(null)", () => {
			const { editor } = makeEditor()
			editor.setPendingImageIndicator("Image in clipboard · ctrl+v to paste")
			expect(editor.render(80).map(stripAnsi)).toHaveLength(4)
			editor.setPendingImageIndicator(null)
			expect(editor.render(80).map(stripAnsi)).toHaveLength(3)
		})

		it("no-ops when setPendingImageIndicator receives the same value twice", () => {
			const { editor, tui } = makeEditor()
			const spy = vi.spyOn(tui, "requestRender")
			editor.setPendingImageIndicator("hello")
			editor.setPendingImageIndicator("hello")
			expect(spy).toHaveBeenCalledTimes(1)
		})
	})

	describe("render — session indicator", () => {
		it("combines session indicator and pending image indicator with a space", () => {
			const { editor } = makeEditor()
			editor.setSessionIndicator("(host)")
			editor.setPendingImageIndicator("📎 1 image (5 KB)")
			const lines = editor.render(80).map(stripAnsi)
			const indicatorRow = lines[1]
			expect(indicatorRow).toContain("(host)")
			expect(indicatorRow).toContain("📎 1 image (5 KB)")
			// Space-separated.
			expect(indicatorRow).toContain("(host) 📎 1 image (5 KB)")
		})

		it("shows only the session indicator when no pending image is set", () => {
			const { editor } = makeEditor()
			editor.setSessionIndicator("(host)")
			const lines = editor.render(80).map(stripAnsi)
			expect(lines).toHaveLength(4)
			expect(lines[1]).toContain("(host)")
			expect(lines[1]).not.toContain("clipboard")
		})
	})

	describe("render — typed text with chevron", () => {
		it("uses ❯ prefix only on the cursor row and two-space indent on other rows", () => {
			const { editor } = makeEditor()
			editor.setText("first line of input")
			const lines = editor.render(80).map(stripAnsi)
			// No indicator set, so 3 rows: top border, cursor row, bottom border.
			expect(lines).toHaveLength(3)
			expect(lines[1].startsWith("❯ ")).toBe(true)
		})
	})
})
