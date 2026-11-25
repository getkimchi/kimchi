import { describe, expect, it } from "vitest"
import { stripAnsi } from "./transcript-replay.js"

describe("stripAnsi", () => {
	it("returns unchanged text when no ANSI escapes are present", () => {
		expect(stripAnsi("plain text")).toBe("plain text")
	})
	it("removes CSI sequences (color, dim, reset) without touching surrounding text", () => {
		expect(stripAnsi("\x1b[2mfoo\x1b[22m bar")).toBe("foo bar")
		expect(stripAnsi("\x1b[31mred\x1b[0m and \x1b[1mbold\x1b[0m")).toBe("red and bold")
	})
	it("leaves a stray ESC byte (no full sequence) untouched", () => {
		// Conservative scrub: only `\x1b[…<letter>` is dropped. A bare ESC
		// without a CSI body isn't styling and shouldn't be mangled.
		expect(stripAnsi("plain\x1bbody")).toBe("plain\x1bbody")
	})
})
