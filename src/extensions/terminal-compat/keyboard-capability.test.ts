import { beforeEach, describe, expect, it, vi } from "vitest"

describe("keyboard-capability", () => {
	beforeEach(() => {
		vi.resetModules()
	})

	describe("getKittyKeyboardSupport", () => {
		it("returns undefined before probing", async () => {
			const { getKittyKeyboardSupport } = await import("./keyboard-capability.js")
			expect(getKittyKeyboardSupport()).toBeUndefined()
		})
	})

	describe("probeKittyKeyboardSupport", () => {
		it("returns false in non-TTY envs (CI / vitest)", async () => {
			const originalTermEmulator = process.env.TERMINAL_EMULATOR
			try {
				// biome-ignore lint/performance/noDelete: ensure no JetBrains detection leaks in.
				delete process.env.TERMINAL_EMULATOR
				const { probeKittyKeyboardSupport, getKittyKeyboardSupport } = await import("./keyboard-capability.js")
				const result = await probeKittyKeyboardSupport()
				// In CI stdin/stdout aren't TTYs, so shouldSkipProbe returns true.
				expect(result).toBe(false)
				expect(getKittyKeyboardSupport()).toBe(false)
			} finally {
				if (originalTermEmulator !== undefined) {
					process.env.TERMINAL_EMULATOR = originalTermEmulator
				}
			}
		})

		it("returns true for JetBrains terminals regardless of TTY", async () => {
			const originalTermEmulator = process.env.TERMINAL_EMULATOR
			try {
				process.env.TERMINAL_EMULATOR = "JetBrains-JediTerm"
				const { probeKittyKeyboardSupport, getKittyKeyboardSupport } = await import("./keyboard-capability.js")
				const result = await probeKittyKeyboardSupport()
				expect(result).toBe(true)
				expect(getKittyKeyboardSupport()).toBe(true)
			} finally {
				if (originalTermEmulator !== undefined) {
					process.env.TERMINAL_EMULATOR = originalTermEmulator
				} else {
					// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
					delete process.env.TERMINAL_EMULATOR
				}
			}
		})

		it("returns true for reworked JetBrains terminal", async () => {
			const originalTermEmulator = process.env.TERMINAL_EMULATOR
			try {
				process.env.TERMINAL_EMULATOR = "JetBrains-Terminal-2025"
				const { probeKittyKeyboardSupport, getKittyKeyboardSupport } = await import("./keyboard-capability.js")
				const result = await probeKittyKeyboardSupport()
				expect(result).toBe(true)
				expect(getKittyKeyboardSupport()).toBe(true)
			} finally {
				if (originalTermEmulator !== undefined) {
					process.env.TERMINAL_EMULATOR = originalTermEmulator
				} else {
					// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
					delete process.env.TERMINAL_EMULATOR
				}
			}
		})
	})
})
