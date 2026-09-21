import { initTheme } from "@earendil-works/pi-coding-agent"
import { beforeAll, describe, expect, it } from "vitest"
import { contentLineRange, isBorderLine, isScrollBorderLine, stripCursorMarker } from "./editor.js"

beforeAll(() => {
	initTheme("default")
})

const ACCENT = "\x1b[38;5;214m"
const RST = "\x1b[0m"

describe("stripCursorMarker", () => {
	it("removes the \\x1b_pi:c marker with BEL terminator", () => {
		const out = stripCursorMarker("hello\x1b_pi:c\x07")
		expect(out).toBe("hello")
	})

	it("removes the \\x1b_pi:c marker without BEL terminator", () => {
		const out = stripCursorMarker("x\x1b_pi:c")
		expect(out).toBe("x")
	})

	it("preserves surrounding text", () => {
		const out = stripCursorMarker("abc\x1b_pi:c\x07def")
		expect(out).toBe("abcdef")
	})

	it("is a no-op on lines without the marker", () => {
		const out = stripCursorMarker("plain text")
		expect(out).toBe("plain text")
	})

	it("removes every occurrence when multiple are present", () => {
		const out = stripCursorMarker("\x1b_pi:c\x07a\x1b_pi:c\x07")
		expect(out).toBe("a")
	})

	it("paints no caret of its own, leaving upstream's the only one", () => {
		// Regression: substituting a `▏` here rendered a second caret beside
		// upstream's reverse-video block.
		const upstreamCaret = "\x1b[7mx\x1b[0m"
		const out = stripCursorMarker(`ab\x1b_pi:c\x07${upstreamCaret}`)
		expect(out).not.toContain("▏")
		expect(out).toContain(upstreamCaret)
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

describe("isScrollBorderLine", () => {
	it("matches the upstream scroll indicators in both directions", () => {
		expect(isScrollBorderLine("─── ↑ 3 more ───────")).toBe(true)
		expect(isScrollBorderLine("─── ↓ 12 more ──────")).toBe(true)
		expect(isScrollBorderLine(`${ACCENT}─── ↑ 1 more ───${RST}`)).toBe(true)
	})

	it("does not match plain rules or user text", () => {
		expect(isScrollBorderLine("────────")).toBe(false)
		expect(isScrollBorderLine("3 more attempts")).toBe(false)
	})
})

describe("contentLineRange", () => {
	it("strips a plain top and bottom border", () => {
		const lines = ["──────", "hello", "world", "──────"]
		const { start, end } = contentLineRange(lines)
		expect(lines.slice(start, end)).toEqual(["hello", "world"])
	})

	it("keeps content when the top border is a scroll indicator", () => {
		// Regression: searching for the first line matching the *plain* border
		// pattern skipped this indicator and landed on the bottom border, so
		// every content line was sliced away and the editor rendered empty
		// while the user was still typing.
		const lines = ["─── ↑ 3 more ───", "visible line", "──────────────"]
		const { start, end } = contentLineRange(lines)
		expect(lines.slice(start, end)).toEqual(["visible line"])
	})

	it("keeps content when the bottom border is a scroll indicator", () => {
		const lines = ["──────────────", "visible line", "─── ↓ 2 more ───"]
		const { start, end } = contentLineRange(lines)
		expect(lines.slice(start, end)).toEqual(["visible line"])
	})

	it("keeps content when both borders are scroll indicators", () => {
		const lines = ["─── ↑ 1 more ───", "middle", "─── ↓ 4 more ───"]
		const { start, end } = contentLineRange(lines)
		expect(lines.slice(start, end)).toEqual(["middle"])
	})

	it("does not strip user text that merely sits at the edges", () => {
		const lines = ["first line", "second line"]
		const { start, end } = contentLineRange(lines)
		expect(lines.slice(start, end)).toEqual(["first line", "second line"])
	})
})

describe("contentLineRange on degenerate input", () => {
	it("returns an empty range for no lines", () => {
		expect(contentLineRange([])).toEqual({ start: 0, end: 0 })
	})

	it("keeps a single border-only line rather than slicing past it", () => {
		// A lone border must not produce start > end.
		const { start, end } = contentLineRange(["──────"])
		expect(end).toBeGreaterThanOrEqual(start)
		expect(["──────"].slice(start, end)).toEqual([])
	})

	it("handles a border pair with no content between them", () => {
		const lines = ["──────", "──────"]
		const { start, end } = contentLineRange(lines)
		expect(end).toBeGreaterThanOrEqual(start)
		expect(lines.slice(start, end)).toEqual([])
	})
})
