/**
 * Light-theme bold contrast: markdown `**strong**` spans (and table headers)
 * must carry an explicit foreground color. Bold text with no fg falls back
 * to the terminal's bold/bright color — bright white on many terminals —
 * which is invisible on light themes that pin the terminal background white
 * via OSC 11 (terminal-colors extension).
 *
 * Two paired upstream patches deliver this:
 *   - pi-coding-agent: getMarkdownTheme() gains a `text` style entry.
 *   - pi-tui: the Markdown strong/table-header sites wrap unstyled content
 *     in that entry before applying bold.
 *
 * Headings call `markdownTheme.bold` directly (outside the strong site), so
 * they must keep their own mdHeading color — the guard that the pin does NOT
 * live inside `bold` itself.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent"
import { Markdown } from "@earendil-works/pi-tui"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { lightTestTheme } from "./extensions/__mocks__/theme.js"

type MarkdownThemeWithText = ReturnType<typeof getMarkdownTheme> & { text?: (text: string) => string }

const PI_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme")
const globals = globalThis as Record<symbol, unknown>
let previousTheme: unknown

beforeAll(() => {
	previousTheme = globals[PI_THEME_KEY]
	globals[PI_THEME_KEY] = lightTestTheme
})

afterAll(() => {
	globals[PI_THEME_KEY] = previousTheme
})

function renderFirstLine(markdown: string, defaultTextStyle?: ConstructorParameters<typeof Markdown>[4]): string {
	const md = new Markdown(markdown, 0, 0, getMarkdownTheme(), defaultTextStyle, undefined)
	return md.render(80)[0] ?? ""
}

describe("markdown bold carries an explicit foreground color", () => {
	it("getMarkdownTheme provides a plain-text style pinned to the theme's text token", () => {
		const mdTheme = getMarkdownTheme() as MarkdownThemeWithText
		expect(typeof mdTheme.text).toBe("function")
		expect(mdTheme.text?.("hello")).toContain(lightTestTheme.getFgAnsi("text"))
	})

	it("markdownTheme.bold itself stays a passthrough (headings rely on it)", () => {
		// The pin must NOT live inside bold(): h2+ headings call bold on plain
		// text and wrap their mdHeading color around the result — a pin here
		// would re-color every heading to the text token.
		const mdTheme = getMarkdownTheme() as MarkdownThemeWithText
		expect(mdTheme.bold("hello")).not.toContain(lightTestTheme.getFgAnsi("text"))
	})

	it("renders **strong** spans with the theme text color", () => {
		const line = renderFirstLine("**bold text** and normal")
		expect(line).toContain("bold text")
		expect(line).toContain(lightTestTheme.getFgAnsi("text"))
	})

	it("keeps styled strong content in its own color (user messages)", () => {
		// A distinct artificial color stands in for the enclosing message style
		// (kimchi-light's userMessageText and text tokens resolve to the same
		// grey, which would make the negative assertion vacuous).
		const enclosingColor = "\u001b[38;2;1;2;3m"
		const line = renderFirstLine("**bold text**", {
			color: (text) => `${enclosingColor}${text}\u001b[39m`,
		})
		expect(line).toContain(enclosingColor)
		expect(line).not.toContain(lightTestTheme.getFgAnsi("text"))
	})

	it("keeps heading colors untouched", () => {
		for (const heading of ["## Heading two", "### Heading three"]) {
			const line = renderFirstLine(heading)
			expect(line).toContain(lightTestTheme.getFgAnsi("mdHeading"))
			expect(line).not.toContain(lightTestTheme.getFgAnsi("text"))
		}
	})

	it("renders markdown table headers bold with the theme text color", () => {
		const lines = new Markdown(
			"| a | b |\n|---|---|\n| 1 | 2 |",
			0,
			0,
			getMarkdownTheme(),
			undefined,
			undefined,
		).render(80)
		const headerRow = lines[1] ?? ""
		expect(headerRow).toContain("a")
		expect(headerRow).toContain(lightTestTheme.getFgAnsi("text"))
	})
})
