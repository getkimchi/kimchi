import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { truncateLinesToWidth } from "./truncate-lines.js"

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
