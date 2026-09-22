import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { initTheme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { FeedbackDetailsComponent, MAX_REASON_LENGTH, showFeedbackDetailsDialog } from "./dialog.js"

beforeAll(() => {
	initTheme("default")
})

function makeTui(): TUI {
	return {
		requestRender: vi.fn(),
		terminal: { rows: 40, cols: 80 },
	} as unknown as TUI
}

function makeTheme(): Theme {
	return {
		fg: (_color: string, s: string) => s,
		bg: (_color: string, s: string) => s,
		bold: (s: string) => s,
		getFgAnsi: (_color: string) => "",
	} as unknown as Theme
}

function makeKeybindings(): KeybindingsManager {
	return {
		matches: (_data: string, _action: string) => false,
	} as unknown as KeybindingsManager
}

function makeComponent(sentiment: "positive" | "negative" = "positive", autoModelUsed = false) {
	const tui = makeTui()
	const done = vi.fn()
	const component = new FeedbackDetailsComponent(
		tui,
		makeTheme(),
		makeKeybindings(),
		{ sentiment, autoModelUsed },
		done,
	)
	return { component, done }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: test-only helper
const ANSI_RE = /\x1b\[[0-9;]*m/g
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "")
}

// The ordered reason labels as the dialog actually renders them. Reason rows
// are numbered (`1. Solved my task`), optionally prefixed with the focus
// marker, which makes them easy to pick out of the surrounding chrome.
function renderedReasons(sentiment: "positive" | "negative", autoModelUsed: boolean): string[] {
	const { component } = makeComponent(sentiment, autoModelUsed)
	return component
		.render(100)
		.map((line) => stripAnsi(line).replaceAll("│", "").trim())
		.flatMap((line) => {
			const match = /^(?:→ )?\d+\. (.+?)$/.exec(line)
			return match?.[1] ? [match[1].trimEnd()] : []
		})
}

// Arrow up / down keystrokes the terminal typically emits.
const ARROW_DOWN = "\x1b[B"
const ARROW_UP = "\x1b[A"
const ENTER = "\r"
const ESCAPE = "\x1b"

describe("FeedbackDetailsComponent", () => {
	it("renders the title, positive subtitle, prompt, and hint", () => {
		const { component } = makeComponent("positive", false)
		const text = component.render(100).map(stripAnsi).join("\n")
		expect(text).toContain("Rate response")
		expect(text).toContain("Your rating: Good")
		expect(text).toContain("Why? (optional)")
		expect(text).toContain("[Enter] Submit")
		expect(text).toContain("[Esc] Cancel")
		expect(text).toContain("[↑↓] Select")
		// Tab should no longer appear in the hint.
		expect(text).not.toContain("[Tab]")
		// [Shift+Enter] New line is only present when the editor is visible.
		expect(text).not.toContain("[Shift+Enter] New line")
		// [Enter] Submit must be listed before [Esc] Cancel.
		expect(text.indexOf("[Enter] Submit")).toBeLessThan(text.indexOf("[Esc] Cancel"))
	})

	it("renders the negative subtitle", () => {
		const { component } = makeComponent("negative", false)
		const text = component.render(100).map(stripAnsi).join("\n")
		expect(text).toContain("Your rating: Bad")
	})

	it("hint does not advertise the digit shortcut range", () => {
		const { component } = makeComponent("positive", true)
		// Digit shortcuts still work but are not advertised in the hint.
		const text = component.render(100).map(stripAnsi).join("\n")
		expect(text).not.toContain("[1-6] Select reason")
		expect(text).not.toContain("[1-9]")
		expect(text).not.toContain("[1-5]")
	})

	it("does not render the editor when nothing is selected (default state)", () => {
		const { component } = makeComponent("positive", false)
		const text = component.render(100).map(stripAnsi).join("\n")
		// The placeholder and any editor chrome are absent when no reason is
		// selected (the default state).
		expect(text).not.toContain("start typing to enter details")
		// The newline hint is also absent.
		expect(text).not.toContain("[Shift+Enter] New line")
	})

	it("does not render the editor when any other predefined reason is focused", () => {
		const { component } = makeComponent("positive", false)
		// Move focus to a different predefined reason (index 1, "Followed my instructions").
		component.handleInput("2")
		const text = component.render(100).map(stripAnsi).join("\n")
		expect(text).not.toContain("start typing to enter details")
		expect(text).not.toContain("[Shift+Enter] New line")
	})

	it("renders the editor (visible but not focused) when 'Type your own answer' is focused", () => {
		const { component } = makeComponent("positive", false)
		// 5 reasons without auto-model: 'Type your own answer' is index 4 (digit 5).
		component.handleInput("5")
		const text = component.render(100).map(stripAnsi).join("\n")
		// Editor placeholder is now visible.
		expect(text).toContain("start typing to enter details")
		// [Enter] Submit is still first and [Esc] Cancel is still last in the hint.
		expect(text.indexOf("[Enter] Submit")).toBeLessThan(text.indexOf("[Esc] Cancel"))
	})

	it("out-of-range digit keys are consumed and do not type into the editor", () => {
		const { component, done } = makeComponent("positive", false)
		// Select the first reason explicitly, then press an out-of-range digit.
		// Only 5 reasons exist; pressing "9" should not jump focus, should not
		// submit, and should not type the digit into the editor.
		component.handleInput("1")
		component.handleInput("9")
		// Focus should still be on the first reason: pressing Enter should
		// submit the first reason, proving focus never moved and "9" never
		// reached the editor.
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "Solved my task" })
	})

	it("digits typed into the custom answer are kept verbatim", () => {
		const { component, done } = makeComponent("negative", false)
		// Start typing a free-form answer: the first printable char moves focus
		// into the editor. Digits after that are ordinary text, not jump keys —
		// intercepting them would silently corrupt the submitted reason.
		for (const ch of "took 3 attempts") {
			component.handleInput(ch)
		}
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "took 3 attempts" })
	})

	it("renders the editor when focus moves into the input field (via Down arrow)", () => {
		const { component } = makeComponent("positive", false)
		component.handleInput("5")
		component.handleInput(ARROW_DOWN) // moves focus into the editor
		const text = component.render(100).map(stripAnsi).join("\n")
		expect(text).toContain("start typing to enter details")
	})

	it("hides the editor again when focus returns to a predefined reason from the input field", () => {
		const { component } = makeComponent("positive", false)
		// Go to input, then back to a predefined reason via Up arrow.
		component.handleInput("5")
		component.handleInput(ARROW_DOWN) // editor
		component.handleInput(ARROW_UP) // → "Type your own answer" (editor still visible)
		component.handleInput(ARROW_UP) // → a different predefined reason (editor hidden)
		const text = component.render(100).map(stripAnsi).join("\n")
		expect(text).not.toContain("start typing to enter details")
		expect(text).not.toContain("[Shift+Enter] New line")
	})

	it("lists the positive reasons in order, gated on auto-model", () => {
		// Asserting the exact rendered list covers membership, ordering
		// ("Type your own answer" last), the auto-model gate and the absence
		// of retired entries in one go.
		expect(renderedReasons("positive", true)).toEqual([
			"Solved my task",
			"Followed my instructions",
			"Good code/output quality",
			"Fast response",
			"Auto-model picked the right model",
			"Type your own answer",
		])
		expect(renderedReasons("positive", false)).toEqual([
			"Solved my task",
			"Followed my instructions",
			"Good code/output quality",
			"Fast response",
			"Type your own answer",
		])
	})

	it("lists the negative reasons in order, gated on auto-model", () => {
		expect(renderedReasons("negative", true)).toEqual([
			"Didn't solve the task",
			"Ignored my instructions",
			"Gave incorrect code/output",
			"Too slow",
			"Auto-model picked the wrong model",
			"Type your own answer",
		])
		expect(renderedReasons("negative", false)).toEqual([
			"Didn't solve the task",
			"Ignored my instructions",
			"Gave incorrect code/output",
			"Too slow",
			"Type your own answer",
		])
	})

	it("Enter with no selection submits { reason: '' }", () => {
		const { component, done } = makeComponent("positive", false)
		// No reason selected: pressing Enter submits an empty reason.
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "" })
	})

	it("Selecting 'Type your own answer' and pressing Enter submits { reason: '' }", () => {
		const { component, done } = makeComponent("positive", false)
		// 5 reasons without auto-model: 'Type your own answer' is index 4 (digit 5).
		// A single Enter on 'Type your own answer' submits the editor text
		// (empty here) — no second Enter is needed.
		component.handleInput("5")
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "" })
	})

	it("Typing custom text and pressing Enter submits { reason: customText }", () => {
		const { component, done } = makeComponent("positive", true)
		// 6 reasons with auto-model: 'Type your own answer' is index 5 (digit 6).
		// Typing a character jumps focus into the input field and forwards it.
		component.handleInput("6")
		component.handleInput("c")
		component.handleInput("u")
		component.handleInput("s")
		component.handleInput("t")
		component.handleInput("o")
		component.handleInput("m")
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "custom" })
	})

	it("Digit key 1-9 jumps focus to that reason and Enter submits it", () => {
		const { component, done } = makeComponent("positive", false)
		component.handleInput("3")
		expect(done).not.toHaveBeenCalled()
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "Good code/output quality" })
	})

	it("Digit key 1-N does not type into the editor", () => {
		const { component, done } = makeComponent("positive", false)
		// Even when no letters are typed, digits should NOT be typed into the
		// editor — they should only move focus between reasons.
		component.handleInput("2")
		component.handleInput("4")
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "Fast response" })
	})

	it("Down arrow from no selection jumps to the first reason", () => {
		const { component, done } = makeComponent("positive", false)
		// No selection: Down arrow jumps to the first reason.
		component.handleInput(ARROW_DOWN)
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "Solved my task" })
	})

	it("Down arrow from the last reason moves focus to the input field", () => {
		const { component, done } = makeComponent("positive", false)
		// Reasons (no auto-model): Solved, Followed, Good, Fast, Type your own answer => 5 reasons.
		// Jump to the last reason (5), then press Down once → input focused.
		component.handleInput("5")
		component.handleInput(ARROW_DOWN)
		// From the input field, type a character and submit.
		component.handleInput("x")
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "x" })
	})

	it("Down arrow clamps at the input field", () => {
		const { component, done } = makeComponent("positive", false)
		component.handleInput("5")
		component.handleInput(ARROW_DOWN) // → input
		component.handleInput(ARROW_DOWN) // still input
		component.handleInput(ARROW_DOWN) // still input
		// From input with empty editor, Enter submits an empty reason.
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "" })
	})

	it("Up arrow moves focus to the previous reason", () => {
		const { component, done } = makeComponent("positive", false)
		// Start by selecting reason 2 explicitly, then press Up to move to
		// reason 1, then Enter to submit reason 1 ("Solved my task").
		component.handleInput("2")
		component.handleInput(ARROW_UP) // → reason 1
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "Solved my task" })
	})

	it("Up arrow from the input field moves focus to the last reason", () => {
		const { component, done } = makeComponent("positive", false)
		// 5 reasons without auto-model: digit 5 is the last one ("Type your own
		// answer"), Down moves into the input, Up comes back to it. Pressing
		// Enter there would submit an empty reason either way, so type instead:
		// that jumps focus back to the input and forwards the character, which
		// only happens if Up really landed on a reason.
		component.handleInput("5")
		component.handleInput(ARROW_DOWN) // → input
		component.handleInput(ARROW_UP) // → back to the last reason
		component.handleInput("z")
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "z" })
	})

	it("Up arrow clamps at the first reason", () => {
		const { component, done } = makeComponent("positive", false)
		// Select the first reason explicitly; Up should keep it there.
		component.handleInput("1")
		component.handleInput(ARROW_UP)
		component.handleInput(ARROW_UP)
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "Solved my task" })
	})

	it("Typing a letter while a reason is focused moves focus to input and types the letter", () => {
		const { component, done } = makeComponent("positive", false)
		component.handleInput("h")
		component.handleInput("e")
		component.handleInput("l")
		component.handleInput("l")
		component.handleInput("o")
		// Editor now contains "hello". Enter from the input submits custom text.
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "hello" })
	})

	it("Escape cancels and resolves with undefined", () => {
		const { component, done } = makeComponent("positive", false)
		component.handleInput("a")
		component.handleInput("b")
		component.handleInput(ESCAPE)
		expect(done).toHaveBeenCalledWith(undefined)
	})
})

describe("showFeedbackDetailsDialog", () => {
	it("calls ctx.ui.custom with overlay options", async () => {
		const custom = vi.fn(
			async (_factory: unknown, _opts: unknown): Promise<{ reason: string }> => ({
				reason: "Solved my task",
			}),
		)
		const ctx = {
			ui: { custom },
		} as unknown as ExtensionContext
		await showFeedbackDetailsDialog(ctx, { sentiment: "positive", autoModelUsed: false })
		expect(custom).toHaveBeenCalledTimes(1)
		const opts = custom.mock.calls[0]?.[1]
		expect(opts).toMatchObject({
			overlay: true,
			overlayOptions: { anchor: "center", width: "70%", maxHeight: "80%" },
		})
	})
})

describe("FeedbackDetailsComponent multi-line caret navigation", () => {
	/**
	 * Drives the component's private editor directly: the test keybindings mock
	 * matches nothing, so the real upstream editor would not turn an arrow into
	 * a caret move. What matters here is the routing decision — whether the
	 * dialog forwards the key or steals it to move focus.
	 */
	function withEditor(component: FeedbackDetailsComponent) {
		const editor = (
			component as unknown as { editor: { getText(): string; handleInput(d: string): void; focused: boolean } }
		).editor
		const handleInput = vi.spyOn(editor, "handleInput")
		return { editor, handleInput }
	}

	function focusEditor(component: FeedbackDetailsComponent) {
		// Walk focus to the input field past every reason.
		for (let i = 0; i < 10; i++) component.handleInput(ARROW_DOWN)
	}

	it("forwards arrows to the editor once the answer spans multiple lines", () => {
		const { component } = makeComponent()
		const { editor, handleInput } = withEditor(component)
		vi.spyOn(editor, "getText").mockReturnValue("first line\nsecond line")
		focusEditor(component)
		handleInput.mockClear()

		component.handleInput(ARROW_UP)
		component.handleInput(ARROW_DOWN)

		expect(handleInput).toHaveBeenCalledWith(ARROW_UP)
		expect(handleInput).toHaveBeenCalledWith(ARROW_DOWN)
	})

	it("keeps the answer focused while arrowing through a multi-line answer", () => {
		const { component } = makeComponent()
		const { editor } = withEditor(component)
		vi.spyOn(editor, "getText").mockReturnValue("first line\nsecond line")
		focusEditor(component)

		component.handleInput(ARROW_UP)

		// Focus must not jump back to the reason list mid-answer. `render`
		// syncs the editor's focus flag, so it reflects the routing decision.
		component.render(100)
		expect(editor.focused).toBe(true)
	})

	it("still moves focus out of a single-line answer", () => {
		const { component } = makeComponent()
		const { editor, handleInput } = withEditor(component)
		vi.spyOn(editor, "getText").mockReturnValue("just one line")
		focusEditor(component)
		handleInput.mockClear()

		component.handleInput(ARROW_UP)

		// Not forwarded — the dialog keeps arrows for focus movement.
		expect(handleInput).not.toHaveBeenCalled()
	})

	it("does not forward arrows while a predefined reason is focused", () => {
		const { component } = makeComponent()
		const { editor, handleInput } = withEditor(component)
		vi.spyOn(editor, "getText").mockReturnValue("first line\nsecond line")
		// Focus the first reason only.
		component.handleInput(ARROW_DOWN)
		handleInput.mockClear()

		component.handleInput(ARROW_DOWN)

		expect(handleInput).not.toHaveBeenCalled()
	})
})

describe("FeedbackDetailsComponent free-form length cap", () => {
	function typeInto(component: FeedbackDetailsComponent, text: string) {
		const editor = (component as unknown as { editor: { getText(): string } }).editor
		vi.spyOn(editor, "getText").mockReturnValue(text)
		// Move focus to the input field so submit() reads the editor.
		for (let i = 0; i < 10; i++) component.handleInput(ARROW_DOWN)
	}

	it("caps a pasted reason at MAX_REASON_LENGTH on submit", () => {
		const { component, done } = makeComponent()
		typeInto(component, "a".repeat(100_000))

		component.handleInput(ENTER)

		const reason = done.mock.calls[0]?.[0]?.reason as string
		expect(reason).toHaveLength(MAX_REASON_LENGTH)
	})

	it("leaves a normal-length reason untouched", () => {
		const { component, done } = makeComponent()
		typeInto(component, "it was too slow")

		component.handleInput(ENTER)

		expect(done).toHaveBeenCalledWith({ reason: "it was too slow" })
	})

	it("keeps a reason of exactly the cap intact", () => {
		const { component, done } = makeComponent()
		const exact = "b".repeat(MAX_REASON_LENGTH)
		typeInto(component, exact)

		component.handleInput(ENTER)

		expect(done).toHaveBeenCalledWith({ reason: exact })
	})
})
