import { describe, expect, it } from "vitest"
import { CUBE, estimateTerminalBackground, GRAY, hexToBgAnsi, rgbTo256, tintBackground } from "./terminal-bg-probe.js"

describe("tintBackground", () => {
	const dark = { r: 0x1a, g: 0x18, b: 0x18 }
	const light = { r: 0xf0, g: 0xf0, b: 0xf0 }

	it("lifts dark background toward white", () => {
		const result = tintBackground(dark, 14, 0, "truecolor")
		const r = Number.parseInt(result.slice(1, 3), 16)
		expect(r).toBeGreaterThan(dark.r)
	})

	it("drops light background toward black", () => {
		const result = tintBackground(light, 14, 0, "truecolor")
		const r = Number.parseInt(result.slice(1, 3), 16)
		expect(r).toBeLessThan(light.r)
	})

	it("applies red bias on dark background", () => {
		const plain = tintBackground(dark, 14, 0, "truecolor")
		const biased = tintBackground(dark, 14, 10, "truecolor")
		const rPlain = Number.parseInt(plain.slice(1, 3), 16)
		const rBiased = Number.parseInt(biased.slice(1, 3), 16)
		expect(rBiased).toBeGreaterThan(rPlain)
	})

	it("clamps result to 0–255", () => {
		const white = { r: 255, g: 255, b: 255 }
		const result = tintBackground(white, 14, 0, "truecolor")
		const r = Number.parseInt(result.slice(1, 3), 16)
		expect(r).toBeLessThanOrEqual(255)
		expect(r).toBeGreaterThanOrEqual(0)
	})

	it("scales delta in 256-color mode and floors at 10", () => {
		// delta 6 → max(round(6*1.4), 10) = max(8, 10) = 10
		const result256 = tintBackground(dark, 6, 0, "256color")
		const resultTc = tintBackground(dark, 6, 0, "truecolor")
		// 256-color should shift more than truecolor (delta 10 vs 6)
		const r256 = Number.parseInt(result256.slice(1, 3), 16)
		const rTc = Number.parseInt(resultTc.slice(1, 3), 16)
		expect(r256).toBeGreaterThan(rTc)
	})

	it("pending and success deltas produce distinct truecolor hex values", () => {
		// In truecolor mode deltas 6 and 12 always produce different hex strings.
		// 256-color mode may collapse them on very dark bgs (gray ramp step = 10),
		// so we only assert distinction in truecolor.
		const pending = tintBackground(dark, 6, 0, "truecolor")
		const success = tintBackground(dark, 12, 0, "truecolor")
		expect(pending).not.toBe(success)
	})
})

describe("rgbTo256", () => {
	it("maps pure gray to the gray ramp", () => {
		const idx = rgbTo256(128, 128, 128)
		expect(idx).toBeGreaterThanOrEqual(232)
		expect(idx).toBeLessThanOrEqual(255)
	})

	it("maps saturated red to the color cube", () => {
		const idx = rgbTo256(255, 0, 0)
		expect(idx).toBeGreaterThanOrEqual(16)
		expect(idx).toBeLessThanOrEqual(231)
	})

	it("maps black to cube index 16", () => {
		expect(rgbTo256(0, 0, 0)).toBe(16)
	})

	it("CUBE and GRAY constants have expected sizes", () => {
		expect(CUBE).toHaveLength(6)
		expect(GRAY).toHaveLength(24)
		expect(GRAY[0]).toBe(8)
		expect(GRAY[23]).toBe(238)
	})
})

describe("hexToBgAnsi", () => {
	it("produces truecolor escape for truecolor mode", () => {
		const result = hexToBgAnsi("#1a1818", "truecolor")
		expect(result).toBe("\x1b[48;2;26;24;24m")
	})

	it("produces 256-color escape for 256color mode", () => {
		const result = hexToBgAnsi("#808080", "256color")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence in test assertion
		expect(result).toMatch(/^\x1b\[48;5;\d+m$/)
	})
})

describe("estimateTerminalBackground", () => {
	const originalEnv = { ...process.env }

	const restore = () => {
		process.env.COLORFGBG = originalEnv.COLORFGBG
		if (originalEnv.COLORFGBG === undefined) process.env.COLORFGBG = undefined
	}

	it("returns dark estimate when COLORFGBG is unset", () => {
		process.env.COLORFGBG = undefined
		const result = estimateTerminalBackground()
		// default dark bg
		expect(result.r).toBe(0x1a)
		restore()
	})

	it("returns white estimate when COLORFGBG background index >= 8", () => {
		process.env.COLORFGBG = "15;15"
		const result = estimateTerminalBackground()
		expect(result.r).toBe(0xff)
		restore()
	})

	it("returns dark estimate when COLORFGBG background index < 8", () => {
		process.env.COLORFGBG = "15;0"
		const result = estimateTerminalBackground()
		expect(result.r).toBe(0x1a)
		restore()
	})
})
