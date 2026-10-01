/**
 * Narrow-terminal width-invariant fuzz for the remaining main-screen
 * components: user messages, assistant Markdown, and thinking steps.
 * pi-tui's doRender hard-crashes on the first over-wide line, so any
 * failure here is a production crash at tiny terminal widths.
 */
import { getMarkdownTheme, initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent"
import { Markdown, visibleWidth } from "@earendil-works/pi-tui"
import { beforeAll, describe, expect, it } from "vitest"
import { deriveThinkingSteps } from "../extensions/thinking-steps/parse.js"
import { renderThinkingStepsLines } from "../extensions/thinking-steps/render.js"
import type { ThinkingSourceBlock, ThinkingThemeLike } from "../extensions/thinking-steps/types.js"

const LONG_TEXT = `This is a long user message that spans multiple semantic chunks and keeps going ${"\u2014 ".repeat(60)}end`

const MARKDOWN_DOC = [
	"# Heading that is fairly long so it wraps",
	"",
	"Some paragraph with a sentence that is long enough to require wrapping at any sane width.",
	"",
	"```ts",
	'const aVeryLongIdentifierName = computeSomething("argument one", "argument two", "argument three")',
	"```",
	"",
	"| column one | column two |",
	"| --- | --- |",
	"| some quite long cell content | another long cell |",
].join("\n")

const thinkingTheme: ThinkingThemeLike = {
	fg: (_color, text) => text,
	bold: (text) => text,
}

function thinkingBlocks(): ThinkingSourceBlock[] {
	return [
		{ contentIndex: 0, text: `step one ${"details ".repeat(40)}\nstep two ${"more ".repeat(40)}`, redacted: false },
	]
}

describe("main-screen narrow-terminal width invariant", () => {
	beforeAll(() => {
		initTheme("default")
	})

	it("UserMessageComponent fits widths 1-12", () => {
		const component = new UserMessageComponent(LONG_TEXT)
		for (let width = 1; width <= 12; width++) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width)
			}
		}
	})

	it("assistant Markdown (headings, code, tables) fits widths 1-12", () => {
		const md = new Markdown(MARKDOWN_DOC, 0, 0, getMarkdownTheme())
		for (let width = 1; width <= 12; width++) {
			for (const line of md.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width)
			}
		}
	})

	for (const mode of ["collapsed", "expanded"] as const) {
		it(`thinking steps (${mode}) fit widths 1-12`, () => {
			const blocks = thinkingBlocks()
			for (let width = 1; width <= 12; width++) {
				const lines = renderThinkingStepsLines(thinkingTheme, width, {
					mode,
					blocks,
					steps: deriveThinkingSteps(blocks),
					activeStepId: undefined,
					isActive: mode === "collapsed",
					nowMs: 1000,
				})
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width)
				}
			}
		})
	}
})
