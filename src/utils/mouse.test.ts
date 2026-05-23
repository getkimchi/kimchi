import { describe, expect, it } from "vitest"
import {
	createClickDetector,
	disableMouseMode,
	enableMouseMode,
	isMouseEvent,
	onMouseDown,
	onMouseUp,
	parseSgrMouse,
} from "./mouse.js"

describe("isMouseEvent", () => {
	it("returns true for SGR press", () => {
		expect(isMouseEvent("\x1b[<0;5;10M")).toBe(true)
	})

	it("returns true for SGR release", () => {
		expect(isMouseEvent("\x1b[<0;5;10m")).toBe(true)
	})

	it("returns false for plain text", () => {
		expect(isMouseEvent("hello")).toBe(false)
	})

	it("returns false for escape sequences", () => {
		expect(isMouseEvent("\x1b[A")).toBe(false)
	})
})

describe("parseSgrMouse", () => {
	it("parses left button press", () => {
		const e = parseSgrMouse("\x1b[<0;10;20M")
		expect(e).not.toBeNull()
		expect(e?.button).toBe(0)
		expect(e?.x).toBe(10)
		expect(e?.y).toBe(20)
		expect(e?.isPress).toBe(true)
		expect(e?.shift).toBe(false)
		expect(e?.isMotion).toBe(false)
		expect(e?.isScroll).toBe(false)
	})

	it("parses release", () => {
		const e = parseSgrMouse("\x1b[<0;10;20m")
		expect(e?.isPress).toBe(false)
		expect(e?.isMotion).toBe(false)
		expect(e?.isScroll).toBe(false)
	})

	it("parses shift modifier", () => {
		const e = parseSgrMouse("\x1b[<4;1;1M")
		expect(e?.button).toBe(0)
		expect(e?.shift).toBe(true)
		expect(e?.isMotion).toBe(false)
	})

	it("parses ctrl modifier", () => {
		const e = parseSgrMouse("\x1b[<16;1;1M")
		expect(e?.ctrl).toBe(true)
		expect(e?.isMotion).toBe(false)
	})

	it("parses motion events", () => {
		const e = parseSgrMouse("\x1b[<32;5;10M")
		expect(e?.button).toBe(0)
		expect(e?.isMotion).toBe(true)
		expect(e?.isScroll).toBe(false)
		expect(e?.isPress).toBe(true)
	})

	it("parses scroll up", () => {
		const e = parseSgrMouse("\x1b[<64;5;10M")
		expect(e?.button).toBe(0)
		expect(e?.isMotion).toBe(false)
		expect(e?.isScroll).toBe(true)
		expect(e?.isPress).toBe(true)
	})

	it("parses scroll down", () => {
		const e = parseSgrMouse("\x1b[<65;5;10M")
		expect(e?.button).toBe(1)
		expect(e?.isMotion).toBe(false)
		expect(e?.isScroll).toBe(true)
		expect(e?.isPress).toBe(true)
	})
})

describe("click detector", () => {
	it("detects a click when press and release are at same position", () => {
		let state = createClickDetector()
		const press = {
			button: 0,
			x: 5,
			y: 10,
			isPress: true,
			shift: false,
			meta: false,
			ctrl: false,
			isMotion: false,
			isScroll: false,
		}
		const release = {
			button: 0,
			x: 5,
			y: 10,
			isPress: false,
			shift: false,
			meta: false,
			ctrl: false,
			isMotion: false,
			isScroll: false,
		}

		state = onMouseDown(state, press)
		const result = onMouseUp(state, release)

		expect(result.isClick).toBe(true)
		expect(result.click?.x).toBe(5)
		expect(result.click?.y).toBe(10)
	})

	it("does not detect click when coordinates differ", () => {
		let state = createClickDetector()
		const press = {
			button: 0,
			x: 5,
			y: 10,
			isPress: true,
			shift: false,
			meta: false,
			ctrl: false,
			isMotion: false,
			isScroll: false,
		}
		const release = {
			button: 0,
			x: 10,
			y: 10,
			isPress: false,
			shift: false,
			meta: false,
			ctrl: false,
			isMotion: false,
			isScroll: false,
		}

		state = onMouseDown(state, press)
		const result = onMouseUp(state, release)

		expect(result.isClick).toBe(false)
	})

	it("does not detect click when button differs", () => {
		let state = createClickDetector()
		const press = {
			button: 0,
			x: 5,
			y: 10,
			isPress: true,
			shift: false,
			meta: false,
			ctrl: false,
			isMotion: false,
			isScroll: false,
		}
		const release = {
			button: 1,
			x: 5,
			y: 10,
			isPress: false,
			shift: false,
			meta: false,
			ctrl: false,
			isMotion: false,
			isScroll: false,
		}

		state = onMouseDown(state, press)
		const result = onMouseUp(state, release)

		expect(result.isClick).toBe(false)
	})

	it("detects click when release sends button=3 (all-buttons-released)", () => {
		let state = createClickDetector()
		const press = {
			button: 0,
			x: 5,
			y: 10,
			isPress: true,
			shift: false,
			meta: false,
			ctrl: false,
			isMotion: false,
			isScroll: false,
		}
		const release = {
			button: 3,
			x: 5,
			y: 10,
			isPress: false,
			shift: false,
			meta: false,
			ctrl: false,
			isMotion: false,
			isScroll: false,
		}

		state = onMouseDown(state, press)
		const result = onMouseUp(state, release)

		expect(result.isClick).toBe(true)
		expect(result.click?.x).toBe(5)
		expect(result.click?.y).toBe(10)
	})

	it("does not detect click when too much time passes", () => {
		const state = createClickDetector()
		// Manually set lastPressTime far in the past
		;(state as unknown as { lastPressTime: number }).lastPressTime = 0
		const release = {
			button: 0,
			x: 5,
			y: 10,
			isPress: false,
			shift: false,
			meta: false,
			ctrl: false,
			isMotion: false,
			isScroll: false,
		}

		const result = onMouseUp(state, release)
		expect(result.isClick).toBe(false)
	})
})

describe("mouse mode sequences", () => {
	it("enables mode 1000 + 1006 (basic tracking + SGR), NOT mode 1002 (motion tracking)", () => {
		const seq = enableMouseMode()
		// Mode 1000h = basic X11 tracking (press/release only).
		// Mode 1006h = SGR coordinate format.
		// Mode 1002h = button-event tracking (motion while pressed) — we MUST NOT
		// enable this because it breaks native terminal selection in most emulators.
		expect(seq).toContain("\x1b[?1000h")
		expect(seq).toContain("\x1b[?1006h")
		expect(seq).not.toContain("\x1b[?1002h")
	})

	it("disables the same modes it enables", () => {
		const disable = disableMouseMode()
		expect(disable).toContain("\x1b[?1000l")
		expect(disable).toContain("\x1b[?1006l")
		expect(disable).not.toContain("\x1b[?1002l")
	})
})
