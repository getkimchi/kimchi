import { describe, expect, it } from "vitest"
import { getKittyKeyboardSupport, probeKittyKeyboardSupport } from "./keyboard-capability.js"

describe("getKittyKeyboardSupport", () => {
	it("returns undefined before probing", () => {
		expect(getKittyKeyboardSupport()).toBeUndefined()
	})
})

describe("probeKittyKeyboardSupport", () => {
	it("returns false in non-TTY envs (CI / vitest)", async () => {
		const result = await probeKittyKeyboardSupport()
		// In CI stdin/stdout aren't TTYs, so shouldSkipProbe returns true.
		expect(result).toBe(false)
		expect(getKittyKeyboardSupport()).toBe(false)
	})
})
