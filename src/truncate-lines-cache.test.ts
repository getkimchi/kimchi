import { beforeEach, describe, expect, it, vi } from "vitest"

const upstream = vi.hoisted(() => ({ calls: 0 }))
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>()
	return {
		...actual,
		truncateToWidth: (...args: Parameters<typeof actual.truncateToWidth>) => {
			upstream.calls++
			return actual.truncateToWidth(...args)
		},
	}
})

const actualTui = await vi.importActual<typeof import("@earendil-works/pi-tui")>("@earendil-works/pi-tui")

import { StatusLineScript } from "./components/status-line.js"
import { resetTruncateToWidthCacheForTests, truncateLinesToWidth, truncateLineToWidth } from "./truncate-lines.js"

const paintedLines = [
	"\x1b[31mstatus: αααα e\u0301 漢字漢字漢字\x1b[0m",
	"tool output with a hyperlink \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
	"prefix\twide 😀😀😀😀 tail",
	"plain ASCII line that must be truncated",
	"\x1b[32msecond status row αααα\x1b[0m",
	"last unchanged tool row 漢字漢字",
]

beforeEach(() => {
	resetTruncateToWidthCacheForTests()
	upstream.calls = 0
})

describe("truncateToWidth paint cache", () => {
	it("computes each unchanged row once over 20 wrapper paints", () => {
		const expected = paintedLines.map((line) => actualTui.truncateToWidth(line, 20))
		for (let paint = 0; paint < 20; paint++) expect(truncateLinesToWidth(paintedLines, 20)).toEqual(expected)
		// The same probe made 120 upstream calls before memoization.
		expect(upstream.calls).toBe(paintedLines.length)
	})

	it("computes each unchanged StatusLineScript row once over 20 renders", () => {
		const status = new StatusLineScript(() => null)
		const lines = paintedLines.slice(0, 3)
		status.setLines(lines)
		const expected = lines.map((line) => actualTui.truncateToWidth(line, 20))
		for (let paint = 0; paint < 20; paint++) expect(status.render(20)).toEqual(expected)
		// The same probe made 60 upstream calls before memoization.
		expect(upstream.calls).toBe(lines.length)
	})

	it("keys results by full text, width, ellipsis and padding", () => {
		const text = "\x1b[35m漢字 alpha e\u0301 😀\x1b[0m"
		const inputs = [
			[text, 8, "...", false],
			[text, 8, "…", false],
			[text, 8, "", false],
			[text, 8, "...", true],
			[text, 12, "...", false],
			[`${text} changed`, 8, "...", false],
		] as const
		const expected = inputs.map(([value, width, ellipsis, pad]) =>
			actualTui.truncateToWidth(value, width, ellipsis, pad),
		)
		for (let repeat = 0; repeat < 2; repeat++) {
			inputs.forEach(([value, width, ellipsis, pad], index) => {
				expect(truncateLineToWidth(value, width, ellipsis, pad)).toBe(expected[index])
			})
		}
		expect(upstream.calls).toBe(inputs.length)
	})

	it("bypasses the cache for oversized inputs and rendered results", () => {
		const oversized = "x".repeat(4097)
		const inputs = [
			[oversized, 20, "...", false],
			["abc", 20, oversized, false],
			["abc", oversized.length, "...", true],
		] as const

		for (const [text, width, ellipsis, pad] of inputs) {
			const expected = actualTui.truncateToWidth(text, width, ellipsis, pad)
			expect(truncateLineToWidth(text, width, ellipsis, pad)).toBe(expected)
			expect(truncateLineToWidth(text, width, ellipsis, pad)).toBe(expected)
		}
		expect(upstream.calls).toBe(inputs.length * 2)
	})

	it("keeps 128 recently used entries and evicts the least recently used", () => {
		const row = (index: number) => `row ${index} 漢字漢字漢字`
		for (let index = 0; index < 128; index++) truncateLineToWidth(row(index), 12)
		expect(upstream.calls).toBe(128)

		truncateLineToWidth(row(0), 12) // Hit; row 0 becomes most recently used.
		expect(upstream.calls).toBe(128)
		truncateLineToWidth(row(128), 12) // Evicts row 1, not the refreshed row 0.
		expect(upstream.calls).toBe(129)
		truncateLineToWidth(row(1), 12)
		expect(upstream.calls).toBe(130)
		truncateLineToWidth(row(0), 12)
		expect(upstream.calls).toBe(130)
	})
})
