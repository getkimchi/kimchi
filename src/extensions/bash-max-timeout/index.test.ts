import { describe, expect, it } from "vitest"
import { bashMaxTimeoutSecondsFor } from "./index.js"

describe("bashMaxTimeoutSecondsFor", () => {
	it("returns the default in seconds when the call has no timeout", () => {
		expect(bashMaxTimeoutSecondsFor({}, 60_000)).toBe(60)
	})

	it("returns the per-call override in seconds when set", () => {
		expect(bashMaxTimeoutSecondsFor({ timeout: 5 }, 60_000)).toBe(5)
	})

	it("rounds the default up to the next whole second", () => {
		expect(bashMaxTimeoutSecondsFor({}, 2_500)).toBe(3)
	})

	it("treats non-positive overrides as missing", () => {
		expect(bashMaxTimeoutSecondsFor({ timeout: 0 }, 60_000)).toBe(60)
		expect(bashMaxTimeoutSecondsFor({ timeout: -3 }, 60_000)).toBe(60)
	})

	it("treats non-numeric overrides as missing", () => {
		expect(bashMaxTimeoutSecondsFor({ timeout: "10" }, 60_000)).toBe(60)
	})

	it("clamps the per-call override to defaultMs * 10", () => {
		// defaultMs = 1000 → cap = 10000ms = 10s
		expect(bashMaxTimeoutSecondsFor({ timeout: 999 }, 1_000)).toBe(10)
	})

	it("never returns less than 1 second", () => {
		expect(bashMaxTimeoutSecondsFor({}, 100)).toBe(1)
	})
})
