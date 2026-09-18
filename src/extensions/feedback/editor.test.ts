import { initTheme } from "@earendil-works/pi-coding-agent"
import { beforeAll, describe, expect, it } from "vitest"
import { replaceCursorMarker } from "./editor.js"

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
