import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { compositeKeepingCursor, insertAtColumn, reapplyBackground, withoutCursorMarker } from "./line-paint.js"

const BG = "\x1b[48;5;236m"

describe("reapplyBackground", () => {
	it.each([
		{ name: "full reset", line: "a\x1b[0mb", expected: `a\x1b[0m${BG}b` },
		{ name: "empty reset", line: "a\x1b[mb", expected: `a\x1b[m${BG}b` },
		{ name: "background reset", line: "a\x1b[49mb", expected: `a\x1b[49m${BG}b` },
		{ name: "reset inside a compound SGR", line: "a\x1b[1;0mb", expected: `a\x1b[1;0m${BG}b` },
		{ name: "foreground-only SGR", line: "a\x1b[31mb", expected: "a\x1b[31mb" },
		{ name: "256-colour foreground whose operand is 0", line: "a\x1b[38;5;0mb", expected: "a\x1b[38;5;0mb" },
		{ name: "truecolor foreground with zero channels", line: "a\x1b[38;2;0;0;0mb", expected: "a\x1b[38;2;0;0;0mb" },
		{ name: "plain text", line: "plain", expected: "plain" },
	])("$name", ({ line, expected }) => {
		expect(reapplyBackground(line, BG)).toBe(expected)
	})
})

describe("insertAtColumn", () => {
	it("inserts before the cell at the column, skipping escape sequences", () => {
		expect(insertAtColumn("\x1b[31mab\x1b[0mcd", 2, "|")).toBe("\x1b[31mab\x1b[0m|cd")
	})

	it("counts wide characters by their cell width", () => {
		expect(insertAtColumn("日本x", 4, "|")).toBe("日本|x")
	})

	it("appends past the end of the line", () => {
		expect(insertAtColumn("ab", 10, "|")).toBe("ab|")
	})
})

describe("compositeKeepingCursor", () => {
	it("keeps the cursor marker at its original column", () => {
		const line = `abc${CURSOR_MARKER}defghij`

		const result = compositeKeepingCursor(line, "XY", 6, 2, 10)

		expect(stripTerminalSequences(withoutCursorMarker(result))).toBe("abcdefXYij")
		expect(visibleWidth(result.slice(0, result.indexOf(CURSOR_MARKER)))).toBe(3)
	})

	it("composites lines without a cursor marker", () => {
		const result = compositeKeepingCursor("abcdefghij", "XY", 2, 2, 10)

		expect(result).not.toContain(CURSOR_MARKER)
		expect(stripTerminalSequences(result)).toBe("abXYefghij")
	})
})
