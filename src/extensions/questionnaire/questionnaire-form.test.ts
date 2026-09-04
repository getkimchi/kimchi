import type { Theme } from "@earendil-works/pi-coding-agent"
import { type TUI, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import { createQuestionForm } from "./questionnaire-form.js"
import type { Question } from "./questionnaire-reducer.js"

// Minimal stubs that satisfy what the questionnaire form and the upstream
// Editor actually touch during render. Anything not listed here is unused by
// the render path; the casts keep the typechecker honest.

function makeTui(cols = 80): TUI {
	return {
		requestRender: vi.fn(),
		terminal: { rows: 40, cols },
	} as unknown as TUI
}

function makeTheme(): Theme {
	return {
		fg: (_color: string, s: string) => s,
		bg: (_color: string, s: string) => s,
		bold: (s: string) => s,
	} as unknown as Theme
}

const TEXT_QUESTION: Question = {
	id: "q1",
	label: "Name",
	prompt: "What is your name?",
	type: "text",
	options: [],
	allowOther: false,
	required: true,
}

const SINGLE_QUESTION: Question = {
	id: "q1",
	label: "Choice",
	prompt: "Pick one",
	type: "single",
	options: [
		{ id: "a", label: "Option A" },
		{ id: "b", label: "Option B" },
	],
	allowOther: false,
	required: true,
}

function makeForm(questions: Question[]) {
	const tui = makeTui()
	const done = vi.fn()
	const form = createQuestionForm(tui, makeTheme(), questions, { title: "Test" }, done)
	return { form, tui, done }
}

describe("createQuestionForm render", () => {
	it("renders a title, prompt, and options at a normal width", () => {
		const { form } = makeForm([SINGLE_QUESTION])
		const lines = form.render(60)
		const text = lines.join("\n")
		expect(text).toContain("Test")
		expect(text).toContain("Pick one")
		expect(text).toContain("Option A")
	})

	describe("narrow terminals", () => {
		// Regression: at width <= 2 the upstream Editor received
		// `width - 2 < 0` and threw RangeError on "─".repeat(-1), crashing the
		// whole TUI on extremely small terminals (uncaughtException).
		for (const width of [1, 2, 3]) {
			it(`does not throw and stays within width ${width} in text input mode`, () => {
				const { form } = makeForm([TEXT_QUESTION])
				// Typing a printable char on a text question switches the form
				// into editor input mode — the path that previously crashed.
				form.handleInput?.("a")
				const lines = form.render(width)
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width)
				}
			})

			it(`does not throw and stays within width ${width} in options mode`, () => {
				const { form } = makeForm([SINGLE_QUESTION])
				const lines = form.render(width)
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width)
				}
			})
		}
	})
})
