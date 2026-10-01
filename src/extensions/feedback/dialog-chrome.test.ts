import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { createDialogChrome } from "./dialog-chrome.js"

/**
 * Tags each styled span so tests can assert *which* theme color a row used,
 * while still exercising the padding math against strings that contain
 * non-printing markup — the case a plain identity theme would not catch.
 */
function makeTheme(): Theme {
	return {
		fg: (color: string, s: string) => `<${color}>${s}</${color}>`,
		bg: (_color: string, s: string) => s,
		bold: (s: string) => `<b>${s}</b>`,
		getFgAnsi: () => "",
	} as unknown as Theme
}

function stripTags(s: string): string {
	return s.replace(/<\/?[a-z]+>/g, "")
}

const WIDTH = 40

describe("createDialogChrome", () => {
	it("pads every row to the same visible width", () => {
		const { emptyRow, contentRow, measuredRow, topBorder, bottomBorder } = createDialogChrome(makeTheme(), WIDTH)
		const rows = [topBorder("Title"), emptyRow, contentRow("<dim>hi</dim>", "hi"), measuredRow("hi"), bottomBorder]

		for (const row of rows) {
			expect(visibleWidth(stripTags(row))).toBe(WIDTH)
		}
	})

	it("centers the title within the top border", () => {
		const { topBorder } = createDialogChrome(makeTheme(), WIDTH)

		const plain = stripTags(topBorder("Rate response"))

		expect(plain).toContain(" Rate response ")
		expect(plain.startsWith("╭")).toBe(true)
		expect(plain.endsWith("╮")).toBe(true)
		// Title sits mid-row rather than flush against either corner.
		const left = plain.indexOf(" Rate response ")
		const right = plain.length - left - " Rate response ".length
		expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
	})

	it("pads from the unstyled length so markup does not consume columns", () => {
		const { contentRow } = createDialogChrome(makeTheme(), WIDTH)

		// Same visible text, one styled and one not, must align identically
		// once the markup is stripped back out.
		const styled = contentRow("<muted>abc</muted>", "abc")
		const bare = contentRow("abc", "abc")

		expect(stripTags(styled)).toBe(stripTags(bare))
	})

	it("accepts a numeric raw length as well as the raw string", () => {
		const { contentRow } = createDialogChrome(makeTheme(), WIDTH)

		expect(contentRow("<dim>abc</dim>", 3)).toBe(contentRow("<dim>abc</dim>", "abc"))
	})

	it("measures child renders itself instead of being told the width", () => {
		const { measuredRow, contentRow } = createDialogChrome(makeTheme(), WIDTH)

		// measuredRow derives the length that contentRow has to be given.
		// `→` is double-width-adjacent, so this also pins the measurement to
		// visible columns rather than `String.length`.
		expect(measuredRow("→ ok")).toBe(contentRow("→ ok", visibleWidth("→ ok")))
	})

	it("reports the interior width available to content", () => {
		const { contentWidth } = createDialogChrome(makeTheme(), WIDTH)

		// Two border columns plus two padding columns on each side.
		expect(contentWidth).toBe(WIDTH - 6)
	})
})

describe("createDialogChrome at degenerate widths", () => {
	it("never emits negative padding or throws when the frame is too narrow", () => {
		for (const width of [0, 1, 2, 3, 6]) {
			const { emptyRow, contentRow, measuredRow, topBorder, bottomBorder, contentWidth } = createDialogChrome(
				makeTheme(),
				width,
			)

			expect(contentWidth).toBeGreaterThanOrEqual(1)
			// A title far wider than the frame must still render without throwing.
			expect(() => topBorder("A very long dialog title")).not.toThrow()
			for (const row of [emptyRow, contentRow("<dim>text</dim>", "text"), measuredRow("text"), bottomBorder]) {
				expect(row).not.toContain("NaN")
				expect(row.length).toBeGreaterThan(0)
			}
		}
	})

	it("clamps overlong content instead of padding backwards", () => {
		const { contentRow } = createDialogChrome(makeTheme(), 10)

		// Content wider than the interior: padding clamps to zero rather than
		// producing a `" ".repeat(negative)` RangeError.
		expect(() => contentRow("<dim>far too much text</dim>", "far too much text")).not.toThrow()
	})
})
