import { Box, Text, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"

describe("pi-tui Text — narrow terminals", () => {
	// Regression: at width <= 2*paddingX, the left+right margins alone exceed
	// the terminal width. Before the patch, Text.render pushed lineWithMargins
	// verbatim (no truncation) → lines wider than the terminal → pi-tui crash.
	for (const width of [1, 2, 3, 4, 5, 8, 10, 20]) {
		it(`Text(paddingX=1) never emits a line wider than ${width}`, () => {
			const text = new Text("Stirring…", 1, 1)
			const lines = text.render(width)
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width)
			}
		})
	}

	it("Text without bg at width 2 fits within 2 columns", () => {
		const text = new Text("Cooking…", 1, 0)
		const lines = text.render(2)
		expect(lines.length).toBeGreaterThan(0)
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(2)
		}
	})

	it("Text without bg at width 1 fits within 1 column", () => {
		const text = new Text("Hello World", 1, 0)
		const lines = text.render(1)
		expect(lines.length).toBeGreaterThan(0)
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(1)
		}
	})
})

describe("pi-tui Box — narrow terminals", () => {
	for (const width of [1, 2, 3, 4, 5, 10]) {
		it(`Box(paddingX=1) with Text child never emits a line wider than ${width}`, () => {
			const box = new Box(1, 1)
			box.addChild(new Text("Some long content that should wrap", 0, 0))
			const lines = box.render(width)
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width)
			}
		})
	}

	it("Box without bg at width 2 fits within 2 columns", () => {
		const box = new Box(1, 0)
		box.addChild(new Text("test", 0, 0))
		const lines = box.render(2)
		expect(lines.length).toBeGreaterThan(0)
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(2)
		}
	})
})
