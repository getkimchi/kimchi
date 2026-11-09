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

function makeKeybindings(overrides: { matches?: (data: string, action: string) => boolean } = {}): KeybindingsManager {
	return {
		matches: overrides.matches ?? ((_data: string, _action: string) => false),
	} as unknown as KeybindingsManager
}

// Fixture where "\x7f" is bound to deleteCharBackward (default backspace),
// "\x1b\x7f" to deleteWordBackward (default alt+backspace), "\x1b[3~" to
// deleteCharForward (default Del key), and "\x1b[H" to cursorLineStart (Home).
function makeBackspaceKeybindings(): KeybindingsManager {
	return makeKeybindings({
		matches: (data, action) =>
			(action === "tui.editor.deleteCharBackward" && data === "\x7f") ||
			(action === "tui.editor.deleteWordBackward" && data === "\x1b\x7f") ||
			(action === "tui.editor.deleteCharForward" && data === "\x1b[3~") ||
			(action === "tui.editor.deleteWordForward" && data === "\x1bd") ||
			(action === "tui.editor.cursorLineStart" && data === "\x1b[H") ||
			(action === "tui.editor.cursorRight" && data === "\x1b[C") ||
			(action === "tui.editor.cursorLeft" && data === "\x1b[D"),
	})
}

function makeTheme(): Theme {
	// Stub: only `getFgAnsi` is touched by PromptEditor.render. Cast keeps the
	// typechecker honest while letting us return plain ANSI escapes.
	return {
		getFgAnsi: (_color: string) => "",
	} as unknown as Theme
}

function makeEditor(keybindings?: KeybindingsManager): { editor: PromptEditor; tui: TUI } {
	const tui = makeTui()
	const editor = new PromptEditor(tui, makeEditorTheme(), keybindings ?? makeKeybindings(), makeTheme())
	return { editor, tui }
}

// Strip ANSI escape codes for assertions.
// biome-ignore lint/suspicious/noControlCharactersInRegex: test-only helper
const ANSI_RE = /\x1b\[[0-9;]*m/g
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "")
}

describe("PromptEditor", () => {
	describe("bracketed-paste image-drop interception", () => {
		const OPEN = "\x1b[200~"
		const CLOSE = "\x1b[201~"

		it("offers a complete paste to the drop handler and consumes it when accepted", () => {
			const { editor } = makeEditor()
			const seen: string[] = []
			editor.onImagePathDrop = (text) => {
				seen.push(text)
				return true
			}
			editor.handleInput(`${OPEN}/tmp/cat.png${CLOSE}`)
			expect(seen).toEqual(["/tmp/cat.png"])
			// Consumed: the raw path never lands in the editor text.
			expect(editor.getText()).toBe("")
		})

		it("falls back to upstream text insertion when the handler rejects the paste", () => {
			const { editor } = makeEditor()
			editor.onImagePathDrop = () => false
			editor.handleInput(`${OPEN}/tmp/notes.txt${CLOSE}`)
			expect(editor.getText()).toBe("/tmp/notes.txt")
		})

		it("inserts nothing when no drop handler is registered", () => {
			const { editor } = makeEditor()
			editor.handleInput(`${OPEN}/tmp/cat.png${CLOSE}`)
			expect(editor.getText()).toBe("/tmp/cat.png")
		})

		it("preserves segment order around a consumed drop (before and after text)", () => {
			const { editor } = makeEditor()
			editor.onImagePathDrop = () => true
			editor.handleInput(`describe ${OPEN}/tmp/cat.png${CLOSE} please`)
			expect(editor.getText()).toBe("describe  please")
		})

		it("handles multiple drops in one chunk, in order", () => {
			const { editor } = makeEditor()
			const seen: string[] = []
			editor.onImagePathDrop = (text) => {
				seen.push(text)
				return true
			}
			editor.handleInput(`${OPEN}/tmp/a.png${CLOSE}${OPEN}/tmp/b.png${CLOSE}`)
			expect(seen).toEqual(["/tmp/a.png", "/tmp/b.png"])
			expect(editor.getText()).toBe("")
		})

		it("re-emits unhandled pastes intact while still consuming handled ones", () => {
			const { editor } = makeEditor()
			editor.onImagePathDrop = (text) => text.endsWith(".png")
			editor.handleInput(`${OPEN}/tmp/a.png${CLOSE}${OPEN}/tmp/notes.txt${CLOSE}`)
			expect(editor.getText()).toBe("/tmp/notes.txt")
		})

		it("leaves incomplete pastes to upstream buffering without calling the handler", () => {
			const { editor } = makeEditor()
			const seen: string[] = []
			editor.onImagePathDrop = (text) => {
				seen.push(text)
				return true
			}
			// Opener without closer in this chunk → multi-chunk paste. The drop
			// handler must not see partial content; upstream buffers it and (when
			// the closer arrives) inserts the path as plain text.
			editor.handleInput(`${OPEN}/tmp/cat`)
			expect(seen).toEqual([])
			editor.handleInput(`.png${CLOSE}`)
			expect(seen).toEqual([])
			expect(editor.getText()).toBe("/tmp/cat.png")
		})
	})

	describe("atomic [Image #N] markers", () => {
		// Records every marker-set sync the editor emits after input.
		function watchEdits(editor: PromptEditor): Set<number>[] {
			const edits: Set<number>[] = []
			editor.onImageMarkersEdited = (ids) => edits.push(ids)
			return edits
		}

		it("a single backspace after a marker deletes it whole and emits the empty set", () => {
			const { editor } = makeEditor(makeBackspaceKeybindings())
			const edits = watchEdits(editor)
			editor.setText("fix [Image #1]")
			editor.handleInput("\x7f")
			expect(editor.getText()).toBe("fix ")
			expect(edits).toEqual([new Set()])
		})

		it("atomic marker deletion works even without a registered edit listener", () => {
			const { editor } = makeEditor(makeBackspaceKeybindings())
			editor.setText("fix [Image #1]")
			editor.handleInput("\x7f")
			expect(editor.getText()).toBe("fix ")
		})

		it("marker mid-line is deleted atomically once trailing text is gone", () => {
			const { editor } = makeEditor(makeBackspaceKeybindings())
			const edits = watchEdits(editor)
			editor.setText("see [Image #2] now")
			// Delete " now" character by character — the marker stays intact.
			for (let i = 0; i < 4; i++) editor.handleInput("\x7f")
			expect(editor.getText()).toBe("see [Image #2]")
			expect(edits).toEqual([])
			// The very next backspace swallows the whole marker.
			editor.handleInput("\x7f")
			expect(editor.getText()).toBe("see ")
			expect(edits).toEqual([new Set()])
		})

		it("ordinary backspace is unaffected when there is no trailing marker", () => {
			const { editor } = makeEditor(makeBackspaceKeybindings())
			const edits = watchEdits(editor)
			editor.setText("hello")
			editor.handleInput("\x7f")
			expect(editor.getText()).toBe("hell")
			expect(edits).toEqual([])
		})

		it("alt+backspace (word delete) after a marker deletes it whole", () => {
			const { editor } = makeEditor(makeBackspaceKeybindings())
			const edits = watchEdits(editor)
			editor.setText("fix [Image #1]")
			editor.handleInput("\x1b\x7f")
			expect(editor.getText()).toBe("fix ")
			expect(edits).toEqual([new Set()])
		})

		it("alt+backspace still deletes word-wise when no marker trails the cursor", () => {
			const { editor } = makeEditor(makeBackspaceKeybindings())
			const edits = watchEdits(editor)
			editor.setText("world hello")
			editor.handleInput("\x1b\x7f")
			expect(editor.getText()).toBe("world ")
			expect(edits).toEqual([])
		})

		it("forward-delete (Del) with the cursor before a marker deletes it whole", () => {
			const { editor } = makeEditor(makeBackspaceKeybindings())
			const edits = watchEdits(editor)
			editor.setText("[Image #1] fix")
			editor.handleInput("\x1b[H") // Home — cursor to marker start
			editor.handleInput("\x1b[3~") // Del
			expect(editor.getText()).toBe(" fix")
			expect(edits).toEqual([new Set()])
		})

		it("forward-delete is unaffected when no marker follows the cursor", () => {
			const { editor } = makeEditor(makeBackspaceKeybindings())
			const edits = watchEdits(editor)
			editor.setText("hi")
			editor.handleInput("\x1b[H")
			editor.handleInput("\x1b[3~")
			expect(editor.getText()).toBe("i")
			expect(edits).toEqual([])
		})

		it("alt+d (word delete forward) before a marker deletes it whole", () => {
			const { editor } = makeEditor(makeBackspaceKeybindings())
			const edits = watchEdits(editor)
			editor.setText("[Image #1] fix")
			editor.handleInput("\x1b[H")
			editor.handleInput("\x1bd")
			expect(editor.getText()).toBe(" fix")
			expect(edits).toEqual([new Set()])
		})

		it("alt+d still deletes word-wise when no marker follows the cursor", () => {
			const { editor } = makeEditor(makeBackspaceKeybindings())
			const edits = watchEdits(editor)
			editor.setText("hello world")
			editor.handleInput("\x1b[H")
			editor.handleInput("\x1bd")
			expect(editor.getText()).toBe(" world")
			expect(edits).toEqual([])
		})

		it("completing a marker by typing its closing bracket emits the new set", () => {
			const { editor } = makeEditor(makeBackspaceKeybindings())
			const edits = watchEdits(editor)
			editor.setText("look [Image #1")
			editor.handleInput("]")
			expect(edits).toEqual([new Set([1])])
		})

		it("right arrow jumps over a marker as one atom", () => {
			const { editor } = makeEditor(makeBackspaceKeybindings())
			editor.setText("x[Image #1]y")
			editor.handleInput("\x1b[H")
			editor.handleInput("\x1b[C")
			expect(editor.getCursor().col).toBe(1)
			editor.handleInput("\x1b[C")
			expect(editor.getCursor().col).toBe(11)
			editor.handleInput("\x1b[C")
			expect(editor.getCursor().col).toBe(12)
		})

		it("left arrow jumps back over a marker as one atom", () => {
			const { editor } = makeEditor(makeBackspaceKeybindings())
			editor.setText("x[Image #1]y")
			editor.handleInput("\x1b[D")
			expect(editor.getCursor().col).toBe(11)
			editor.handleInput("\x1b[D")
			expect(editor.getCursor().col).toBe(1)
		})
	})

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

	describe("render — narrow terminals", () => {
		// Regression: at width <= CHEVRON_WIDTH the upstream Editor received a
		// negative content width and threw RangeError on "─".repeat(-1),
		// crashing the whole TUI on extremely small terminals.
		for (const width of [1, 2, 3, 4]) {
			it(`does not throw and stays within width ${width} when empty`, () => {
				const { editor } = makeEditor()
				const lines = editor.render(width)
				expect(lines.length).toBeGreaterThan(0)
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width)
				}
			})

			it(`does not throw and stays within width ${width} with text`, () => {
				const { editor } = makeEditor()
				editor.setText("test")
				const lines = editor.render(width)
				expect(lines.length).toBeGreaterThan(0)
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width)
				}
			})
		}
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
