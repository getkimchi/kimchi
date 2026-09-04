import { getMarkdownTheme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { DottedParagraph } from "./assistant-prefix.js"

// Strip ANSI escape codes for content assertions.
// biome-ignore lint/suspicious/noControlCharactersInRegex: test-only helper
const ANSI_RE = /\x1b\[[0-9;]*m/g
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "")
}

function makeParagraph(text = "hello world"): DottedParagraph {
	return new DottedParagraph(text, getMarkdownTheme())
}

describe("DottedParagraph render", () => {
	it("prefixes the first visible line with a dot and indents the rest", () => {
		const p = makeParagraph()
		// Many lines so Markdown wraps at width 40 (inner width 37).
		const lines = p.render(40).map(stripAnsi)
		expect(lines.some((line) => line.startsWith(" ● "))).toBe(true)
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40)
		}
	})

	describe("narrow terminals", () => {
		// Regression: at width <= 2 the narrow-width guard returned a fixed
		// 3-cell " ● " line. DottedParagraph replaces Markdown children inside
		// AssistantMessageComponent (main screen), where pi-tui hard-crashes
		// on any line wider than the terminal.
		for (const width of [1, 2, 3]) {
			it(`stays within width ${width}`, () => {
				const p = makeParagraph()
				const lines = p.render(width)
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width)
				}
			})

			it(`stays within width ${width} on the cached path too`, () => {
				const p = makeParagraph()
				p.render(width)
				const lines = p.render(width) // cache hit
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width)
				}
			})
		}

		it("never exceeds the requested width across a resize sweep", () => {
			const p = makeParagraph("a reasonably long paragraph that wraps onto several lines when narrow")
			for (let width = 1; width <= 12; width++) {
				for (const line of p.render(width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width)
				}
			}
		})
	})
})
