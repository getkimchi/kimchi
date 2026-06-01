import { describe, expect, it } from "vitest"
import { ChordParser } from "./keybindings.js"

// ctrl+b is char code 2 (0x02). After hitting the prefix the parser awaits
// one operand keystroke and resets to idle regardless of outcome.
const CTRL_B = "\x02"
const ESC = "\x1b"

describe("ChordParser", () => {
	it("returns null for input that does not match the prefix", () => {
		const p = new ChordParser()
		expect(p.process("a")).toBeNull()
		expect(p.isWaiting).toBe(false)
	})

	it("consumes the prefix without producing an action", () => {
		const p = new ChordParser()
		expect(p.process(CTRL_B)).toBe("consumed")
		expect(p.isWaiting).toBe(true)
	})

	it("maps prefix + n to new-tab", () => {
		const p = new ChordParser()
		p.process(CTRL_B)
		expect(p.process("n")).toEqual({ kind: "new-tab" })
		expect(p.isWaiting).toBe(false)
	})

	it("maps prefix + w to close-tab", () => {
		const p = new ChordParser()
		p.process(CTRL_B)
		expect(p.process("w")).toEqual({ kind: "close-tab" })
	})

	it("maps prefix + x to delete-session", () => {
		const p = new ChordParser()
		p.process(CTRL_B)
		expect(p.process("x")).toEqual({ kind: "delete-session" })
	})

	it("maps prefix + 1..9 to switch with the corresponding 0-based index", () => {
		for (let n = 1; n <= 9; n++) {
			const p = new ChordParser()
			p.process(CTRL_B)
			expect(p.process(String(n))).toEqual({ kind: "switch", index: n - 1 })
		}
	})

	it("ignores prefix + 0 (no tab index 0 in the user-facing 1..9 scheme)", () => {
		const p = new ChordParser()
		p.process(CTRL_B)
		expect(p.process("0")).toBe("consumed")
	})

	it("maps prefix + esc to cancel", () => {
		const p = new ChordParser()
		p.process(CTRL_B)
		expect(p.process(ESC)).toEqual({ kind: "cancel" })
	})

	it("swallows unknown operand silently and resets to idle", () => {
		const p = new ChordParser()
		p.process(CTRL_B)
		expect(p.process("q")).toBe("consumed")
		expect(p.isWaiting).toBe(false)
		// next non-prefix input is forwarded again.
		expect(p.process("a")).toBeNull()
	})

	it("does not produce an action on the prefix press itself", () => {
		const p = new ChordParser()
		expect(p.process(CTRL_B)).toBe("consumed")
	})
})
