import { describe, expect, it } from "vitest"
import { stripAnsi } from "./strip-ansi.js"

describe("stripAnsi", () => {
	it("returns plain strings unchanged", () => {
		expect(stripAnsi("hello world")).toBe("hello world")
	})

	it("strips CSI color codes", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red")
	})

	it("strips OSC hyperlink resets", () => {
		const withOsc = "\x1b[0m\x1b]8;;\x07"
		expect(stripAnsi(withOsc)).toBe("")
	})

	it("strips mixed CSI and OSC sequences", () => {
		const mixed = "\x1b[38;2;255;0;0mtext\x1b[0m\x1b]8;;\x07"
		expect(stripAnsi(mixed)).toBe("text")
	})

	it("handles strings with no escape codes", () => {
		expect(stripAnsi("box-drawing ──│")).toBe("box-drawing ──│")
	})
})
