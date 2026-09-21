import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { initTheme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { FeedbackDetailsComponent, showFeedbackDetailsDialog } from "./dialog.js"

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

	it("lists positive predefined options without the removed entries", () => {
		const { component } = makeComponent("positive", false)
		const text = component.render(100).map(stripAnsi).join("\n")
		expect(text).toContain("Solved my task")
		expect(text).toContain("Followed my instructions")
		expect(text).toContain("Good code/output quality")
		expect(text).toContain("Fast response")
		expect(text).toContain("Type your own answer")
	})

	it("positive reasons list does not contain 'Easy to understand' or 'Saved me time'", () => {
		const { component } = makeComponent("positive", true)
		const text = component.render(100).map(stripAnsi).join("\n")
		expect(text).not.toContain("Easy to understand")
		expect(text).not.toContain("Saved me time")
	})

	it("lists negative predefined options", () => {
		const { component } = makeComponent("negative", false)
		const text = component.render(100).map(stripAnsi).join("\n")
		expect(text).toContain("Didn't solve the task")
		expect(text).toContain("Ignored my instructions")
		expect(text).toContain("Gave incorrect code/output")
		expect(text).toContain("Too slow")
	})

	it("shows 'Type your own answer' as the last option for positive sentiment", () => {
		const { component } = makeComponent("positive", true)
		const text = component.render(100).map(stripAnsi).join("\n")
		const ownIdx = text.lastIndexOf("Type your own answer")
		expect(ownIdx).toBeGreaterThan(-1)
		for (const label of [
			"Solved my task",
			"Followed my instructions",
			"Good code/output quality",
			"Fast response",
			"Auto-model picked the right model",
		]) {
			expect(text.indexOf(label)).toBeGreaterThan(-1)
			expect(text.indexOf(label)).toBeLessThan(ownIdx)
		}
	})

	it("shows 'Type your own answer' as the last option for negative sentiment", () => {
		const { component } = makeComponent("negative", true)
		const text = component.render(100).map(stripAnsi).join("\n")
		const ownIdx = text.lastIndexOf("Type your own answer")
		expect(ownIdx).toBeGreaterThan(-1)
		for (const label of [
			"Didn't solve the task",
			"Ignored my instructions",
			"Gave incorrect code/output",
			"Too slow",
			"Auto-model picked the wrong model",
		]) {
			expect(text.indexOf(label)).toBeGreaterThan(-1)
			expect(text.indexOf(label)).toBeLessThan(ownIdx)
		}
	})

	it("omits the auto-model option when auto-model was not used (positive)", () => {
		const { component } = makeComponent("positive", false)
		const text = component.render(100).map(stripAnsi).join("\n")
		expect(text).not.toContain("Auto-model picked the right model")
	})

	it("includes the auto-model option when auto-model was used (positive)", () => {
		const { component } = makeComponent("positive", true)
		const text = component.render(100).map(stripAnsi).join("\n")
		expect(text).toContain("Auto-model picked the right model")
	})

	it("omits the auto-model option when auto-model was not used (negative)", () => {
		const { component } = makeComponent("negative", false)
		const text = component.render(100).map(stripAnsi).join("\n")
		expect(text).not.toContain("Auto-model picked the wrong model")
	})

	it("includes the auto-model option when auto-model was used (negative)", () => {
		const { component } = makeComponent("negative", true)
		const text = component.render(100).map(stripAnsi).join("\n")
		expect(text).toContain("Auto-model picked the wrong model")
	})

	it("Enter with no selection submits { reason: '' }", () => {
		const { component, done } = makeComponent("positive", false)
		// No reason selected: pressing Enter submits an empty reason.
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "" })
	})

	it("Enter with no selection on a negative dialog submits { reason: '' }", () => {
		const { component, done } = makeComponent("negative", false)
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "" })
	})

	it("Selecting a predefined reason and pressing Enter submits { reason: selectedLabel }", () => {
		const { component, done } = makeComponent("positive", false)
		component.handleInput("3")
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "Good code/output quality" })
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

	it("Enter on 'Type your own answer' with text typed in the editor submits the editor text", () => {
		const { component, done } = makeComponent("positive", true)
		// 6 reasons with auto-model: 'Type your own answer' is index 5 (digit 6).
		// Typing a character while the last reason is focused jumps focus to
		// the input field and forwards the character.
		component.handleInput("6")
		component.handleInput("h")
		component.handleInput("i")
		// Single Enter submits the editor text directly without a second press.
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "hi" })
	})

	it("Pressing Enter in empty input submits { reason: '' }", () => {
		const { component, done } = makeComponent("positive", false)
		// Move focus to the input field via Down arrow past the last reason.
		component.handleInput("5")
		component.handleInput(ARROW_DOWN)
		component.handleInput(ENTER) // empty editor → submits ""
		expect(done).toHaveBeenCalledWith({ reason: "" })
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
		// Navigate from reason 0 → input (5 down arrows for 5 reasons), then up
		// once. Without auto-model there are 5 reasons, so the last is index 4
		// ("Type your own answer"). After focusing the input, pressing Up once
		// should land on the last reason. Pressing Enter there would submit an
		// empty reason immediately; typing instead jumps focus back to the
		// input field and forwards the character.
		component.handleInput(ARROW_DOWN) // → reason 1
		component.handleInput(ARROW_DOWN) // → reason 2
		component.handleInput(ARROW_DOWN) // → reason 3
		component.handleInput(ARROW_DOWN) // → reason 4 (last = Type your own answer)
		component.handleInput(ARROW_DOWN) // → input
		component.handleInput(ARROW_UP) // → back to last reason (Type your own answer)
		component.handleInput("z") // jumps focus to input and types "z"
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

	it("When focus is already on the input, typed letters are forwarded normally", () => {
		const { component, done } = makeComponent("positive", false)
		// Move focus to the input via Down arrow past the last reason.
		component.handleInput("5")
		component.handleInput(ARROW_DOWN)
		component.handleInput("a")
		component.handleInput("b")
		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith({ reason: "ab" })
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
