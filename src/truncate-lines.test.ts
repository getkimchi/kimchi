import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { truncateLinesToWidth, truncateLineToWidth } from "./truncate-lines.js"

describe("truncateLinesToWidth", () => {
	it("leaves lines that already fit untouched", () => {
		expect(truncateLinesToWidth(["abc", ""], 10)).toEqual(["abc", ""])
	})

	it("truncates over-wide lines down to the terminal width", () => {
		const out = truncateLinesToWidth(["abcdefghij", "x"], 5)
		expect(out).toHaveLength(2)
		expect(visibleWidth(out[0])).toBeLessThanOrEqual(5)
		expect(out[1]).toBe("x")
	})

	it("handles ANSI-styled lines and widths 1-2 without throwing", () => {
		const styled = ["\x1b[31mhello world\x1b[0m", "─".repeat(40)]
		for (const width of [1, 2]) {
			const out = truncateLinesToWidth(styled, width)
			for (const line of out) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width)
			}
		}
	})
})

describe("truncateLineToWidth upstream equivalence", () => {
	const texts = [
		"plain ASCII text that needs clipping",
		"\x1b[31mred αααα and reset\x1b[0m",
		"\x1b]8;;https://example.com\x1b\\linked 漢字 text\x1b]8;;\x1b\\",
		"tabs\tand\twide 漢字 characters",
		"combining e\u0301 and emoji 😀😀😀",
		"漢字漢字漢字漢字漢字",
		"",
	]

	it("matches every result for ANSI, hyperlinks, tabs and Unicode in all modes", () => {
		for (const text of texts) {
			for (const width of [0, 1, 2, 3, 4, 8, 20]) {
				for (const ellipsis of ["...", "…", ""]) {
					for (const pad of [false, true]) {
						expect(truncateLineToWidth(text, width, ellipsis, pad)).toBe(truncateToWidth(text, width, ellipsis, pad))
					}
				}
			}
		}
	})

	it("matches upstream for fractional and non-finite widths", () => {
		for (const text of texts.slice(0, -1)) {
			for (const width of [-Infinity, -1, -0, 2.5, Number.NaN, Infinity]) {
				expect(truncateLineToWidth(text, width)).toBe(truncateToWidth(text, width))
			}
		}
	})

	it("does not conflate raw ANSI strings with the same display text", () => {
		const red = "\x1b[31munchanged text\x1b[0m"
		const blue = "\x1b[34munchanged text\x1b[0m"
		expect(truncateLineToWidth(red, 30)).toBe(truncateToWidth(red, 30))
		expect(truncateLineToWidth(blue, 30)).toBe(truncateToWidth(blue, 30))
		expect(truncateLineToWidth(red, 30)).not.toBe(truncateLineToWidth(blue, 30))
	})
})
