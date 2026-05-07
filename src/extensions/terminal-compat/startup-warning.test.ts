import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const testDir = resolve(__dirname, "../../.test-startup-warning-fixture")

function rmrf(path: string): void {
	try {
		if (!existsSync(path)) return
		const stat = require("node:fs").statSync(path)
		if (stat.isDirectory()) {
			for (const entry of require("node:fs").readdirSync(path)) {
				rmrf(resolve(path, entry))
			}
			rmSync(path, { recursive: true })
		} else {
			rmSync(path)
		}
	} catch {
		// ignore errors during cleanup
	}
}

beforeEach(() => {
	rmrf(testDir)
	mkdirSync(testDir, { recursive: true })
	vi.resetModules()
})

afterEach(() => {
	rmrf(testDir)
})

describe("emitTerminalCompatWarning", () => {
	it("shows tmux warning when TMUX env is set", async () => {
		const originalTmux = process.env.TMUX
		const originalTermProgram = process.env.TERM_PROGRAM

		try {
			process.env.TMUX = "/tmp/tmux-1000/default,1234,0"
			// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
			delete process.env.TERM_PROGRAM
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })

			const warnings: string[] = []
			vi.spyOn(console, "warn").mockImplementation((msg: string) => {
				warnings.push(msg)
			})

			const { emitTerminalCompatWarning } = await import("./startup-warning.js")
			emitTerminalCompatWarning(testDir)

			expect(warnings.length).toBeGreaterThan(0)
			expect(warnings[0]).toContain("tmux")
			expect(warnings[0]).toContain("extended-keys")
		} finally {
			if (originalTmux !== undefined) {
				process.env.TMUX = originalTmux
			} else {
				// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
				delete process.env.TMUX
			}
			if (originalTermProgram !== undefined) {
				process.env.TERM_PROGRAM = originalTermProgram
			} else {
				// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
				delete process.env.TERM_PROGRAM
			}
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
		}
	})

	it("shows keyboard-protocol warning when getKittyKeyboardSupport returns false", async () => {
		const originalTmux = process.env.TMUX

		try {
			// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
			delete process.env.TMUX
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })

			const warnings: string[] = []
			vi.spyOn(console, "warn").mockImplementation((msg: string) => {
				warnings.push(msg)
			})

			// Mock the keyboard capability getter so we appear unsupported.
			const { getKittyKeyboardSupport } = await import("./keyboard-capability.js")
			vi.spyOn(await import("./keyboard-capability.js"), "getKittyKeyboardSupport").mockReturnValue(false)

			const { emitTerminalCompatWarning } = await import("./startup-warning.js")
			emitTerminalCompatWarning(testDir)

			expect(warnings.length).toBeGreaterThan(0)
			expect(warnings[0]).toContain("does not send modifier keys")
		} finally {
			if (originalTmux !== undefined) {
				process.env.TMUX = originalTmux
			} else {
				// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
				delete process.env.TMUX
			}
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
			vi.restoreAllMocks()
		}
	})

	it("respects nag control - does not show warning twice same day", async () => {
		const originalTmux = process.env.TMUX
		const originalTermProgram = process.env.TERM_PROGRAM

		try {
			process.env.TMUX = "/tmp/tmux-1000/default,1234,0"
			// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
			delete process.env.TERM_PROGRAM
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })

			const warnings: string[] = []
			vi.spyOn(console, "warn").mockImplementation((msg: string) => {
				warnings.push(msg)
			})

			// First call - should show warning
			const { emitTerminalCompatWarning: emit1 } = await import("./startup-warning.js")
			emit1(testDir)
			expect(warnings.length).toBe(1)

			// Second call - should NOT show warning (same day)
			vi.resetModules()
			const { emitTerminalCompatWarning: emit2 } = await import("./startup-warning.js")
			emit2(testDir)
			expect(warnings.length).toBe(1) // Still 1, no new warning
		} finally {
			if (originalTmux !== undefined) {
				process.env.TMUX = originalTmux
			} else {
				// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
				delete process.env.TMUX
			}
			if (originalTermProgram !== undefined) {
				process.env.TERM_PROGRAM = originalTermProgram
			} else {
				// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
				delete process.env.TERM_PROGRAM
			}
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
		}
	})

	it("persists lastTerminalWarnings to settings.json", async () => {
		const originalTmux = process.env.TMUX
		const originalTermProgram = process.env.TERM_PROGRAM
		const settingsPath = resolve(testDir, "settings.json")

		try {
			process.env.TMUX = "/tmp/tmux-1000/default,1234,0"
			// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
			delete process.env.TERM_PROGRAM
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })

			const { emitTerminalCompatWarning } = await import("./startup-warning.js")
			emitTerminalCompatWarning(testDir)

			expect(existsSync(settingsPath)).toBe(true)
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
			expect(settings.lastTerminalWarnings).toBeDefined()
			expect(settings.lastTerminalWarnings?.tmux).toBeDefined()
			expect(settings.lastTerminalWarnings?.tmux).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		} finally {
			if (originalTmux !== undefined) {
				process.env.TMUX = originalTmux
			} else {
				// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
				delete process.env.TMUX
			}
			if (originalTermProgram !== undefined) {
				process.env.TERM_PROGRAM = originalTermProgram
			} else {
				// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
				delete process.env.TERM_PROGRAM
			}
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
		}
	})

	it("does not show warning when not a TTY", async () => {
		try {
			Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })

			const warnings: string[] = []
			vi.spyOn(console, "warn").mockImplementation((msg: string) => {
				warnings.push(msg)
			})

			const { emitTerminalCompatWarning } = await import("./startup-warning.js")
			emitTerminalCompatWarning(testDir)

			expect(warnings.length).toBe(0)
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
		}
	})

	it("preserves existing settings.json fields", async () => {
		const originalTmux = process.env.TMUX
		const originalTermProgram = process.env.TERM_PROGRAM
		const settingsPath = resolve(testDir, "settings.json")

		try {
			process.env.TMUX = "/tmp/tmux-1000/default,1234,0"
			// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
			delete process.env.TERM_PROGRAM
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })

			// Create existing settings.json with custom fields
			writeFileSync(
				settingsPath,
				JSON.stringify({ quietStartup: true, theme: "my-custom-theme", someOtherField: "value" }),
			)

			const { emitTerminalCompatWarning } = await import("./startup-warning.js")
			emitTerminalCompatWarning(testDir)

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
			expect(settings.quietStartup).toBe(true)
			expect(settings.theme).toBe("my-custom-theme")
			expect(settings.someOtherField).toBe("value")
			expect(settings.lastTerminalWarnings).toBeDefined()
		} finally {
			if (originalTmux !== undefined) {
				process.env.TMUX = originalTmux
			} else {
				// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
				delete process.env.TMUX
			}
			if (originalTermProgram !== undefined) {
				process.env.TERM_PROGRAM = originalTermProgram
			} else {
				// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
				delete process.env.TERM_PROGRAM
			}
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
		}
	})
})
