import { initTheme } from "@earendil-works/pi-coding-agent"
import { beforeAll, describe, expect, it } from "vitest"
import { isBorderLine, replaceCursorMarker } from "./editor.js"

beforeAll(() => {
	initTheme("default")
})

const ACCENT = "\x1b[38;5;214m"
const RST = "\x1b[0m"

describe("replaceCursorMarker", () => {
	it("removes the \\x1b_pi:c marker with BEL terminator", () => {
		const out = replaceCursorMarker("hello\x1b_pi:c\x07", ACCENT, RST)
		expect(out).not.toContain("pi:c")
		expect(out).toContain("▏")
	})

	it("removes the \\x1b_pi:c marker without BEL terminator", () => {
		const out = replaceCursorMarker("x\x1b_pi:c", ACCENT, RST)
		expect(out).not.toContain("pi:c")
		expect(out).toContain("▏")
	})

	it("preserves surrounding text", () => {
		const out = replaceCursorMarker("abc\x1b_pi:c\x07def", ACCENT, RST)
		expect(out).toContain("abc")
		expect(out).toContain("def")
		expect(out).toContain("▏")
	})

	it("is a no-op on lines without the marker", () => {
		const out = replaceCursorMarker("plain text", ACCENT, RST)
		expect(out).toBe("plain text")
	})

	it("replaces every occurrence when multiple are present", () => {
		const out = replaceCursorMarker("\x1b_pi:c\x07a\x1b_pi:c\x07", ACCENT, RST)
		expect(out).not.toContain("pi:c")
		const matches = out.match(/▏/g)
		expect(matches?.length).toBe(2)
	})
})

describe("isBorderLine", () => {
	it("matches the upstream editor's horizontal borders", () => {
		expect(isBorderLine("────────")).toBe(true)
		expect(isBorderLine("  ────  ")).toBe(true)
		expect(isBorderLine(`${ACCENT}────${RST}`)).toBe(true)
	})

	it("does not match user text that merely starts with a box-drawing char", () => {
		// Regression: a prefix test would treat these as borders and silently
		// drop the line from the render while still submitting the text.
		expect(isBorderLine("──── my heading")).toBe(false)
		expect(isBorderLine("─ separator note")).toBe(false)
	})

	it("does not match ordinary content", () => {
		expect(isBorderLine("took 3 attempts")).toBe(false)
		expect(isBorderLine("")).toBe(false)
	})
})
