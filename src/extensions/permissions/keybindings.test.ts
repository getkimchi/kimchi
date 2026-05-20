import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { writeKimchiKeybindingDefaults } from "./keybindings.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const testDir = resolve(__dirname, "../../.test-keybindings-fixture")

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
})

afterEach(() => {
	rmrf(testDir)
})

describe("writeKimchiKeybindingDefaults", () => {
	it("creates keybindings.json with shift+tab unbound and ctrl+j newline fallback", () => {
		const keybindingsPath = resolve(testDir, "keybindings.json")

		writeKimchiKeybindingDefaults(testDir)

		expect(existsSync(keybindingsPath)).toBe(true)
		const content = JSON.parse(readFileSync(keybindingsPath, "utf-8"))
		expect(content["app.thinking.cycle"]).toBe("")
		expect(content["tui.input.newLine"]).toBe("shift+enter,ctrl+j")
	})

	it("is idempotent - does not duplicate ctrl+j on re-run", () => {
		const keybindingsPath = resolve(testDir, "keybindings.json")

		writeKimchiKeybindingDefaults(testDir)
		writeKimchiKeybindingDefaults(testDir)

		const content = JSON.parse(readFileSync(keybindingsPath, "utf-8"))
		expect(content["tui.input.newLine"]).toBe("shift+enter,ctrl+j")
		// Should only have shift+enter and ctrl+j, no duplicates
		const parts = content["tui.input.newLine"].split(",")
		expect(parts.filter((p: string) => p === "ctrl+j").length).toBe(1)
	})

	it("preserves existing custom newLine binding and appends ctrl+j", () => {
		const keybindingsPath = resolve(testDir, "keybindings.json")
		writeFileSync(keybindingsPath, JSON.stringify({ "tui.input.newLine": "alt+enter" }))

		writeKimchiKeybindingDefaults(testDir)

		const content = JSON.parse(readFileSync(keybindingsPath, "utf-8"))
		expect(content["tui.input.newLine"]).toBe("alt+enter,ctrl+j")
	})

	it("does NOT add ctrl+j if it's already bound elsewhere", () => {
		const keybindingsPath = resolve(testDir, "keybindings.json")
		// Simulate ctrl+j being used for submit
		writeFileSync(keybindingsPath, JSON.stringify({ "tui.input.submit": "ctrl+j" }))

		writeKimchiKeybindingDefaults(testDir)

		const content = JSON.parse(readFileSync(keybindingsPath, "utf-8"))
		// ctrl+j should NOT be added to newLine since it's used for submit
		expect(content["tui.input.newLine"]).toBeUndefined()
	})

	it("does NOT add ctrl+j if newLine already contains it", () => {
		const keybindingsPath = resolve(testDir, "keybindings.json")
		writeFileSync(keybindingsPath, JSON.stringify({ "tui.input.newLine": "shift+enter,ctrl+j" }))

		writeKimchiKeybindingDefaults(testDir)

		const content = JSON.parse(readFileSync(keybindingsPath, "utf-8"))
		expect(content["tui.input.newLine"]).toBe("shift+enter,ctrl+j")
		const parts = content["tui.input.newLine"].split(",")
		expect(parts.filter((p: string) => p === "ctrl+j").length).toBe(1)
	})

	it("handles malformed existing keybindings.json gracefully", () => {
		const keybindingsPath = resolve(testDir, "keybindings.json")
		writeFileSync(keybindingsPath, "not valid json {{{")

		// Should not throw
		expect(() => writeKimchiKeybindingDefaults(testDir)).not.toThrow()

		const content = JSON.parse(readFileSync(keybindingsPath, "utf-8"))
		expect(content["app.thinking.cycle"]).toBe("")
		expect(content["tui.input.newLine"]).toBe("shift+enter,ctrl+j")
	})

	it("preserves other existing bindings", () => {
		const keybindingsPath = resolve(testDir, "keybindings.json")
		writeFileSync(keybindingsPath, JSON.stringify({ "some.other.binding": "value" }))

		writeKimchiKeybindingDefaults(testDir)

		const content = JSON.parse(readFileSync(keybindingsPath, "utf-8"))
		expect(content["some.other.binding"]).toBe("value")
		expect(content["app.thinking.cycle"]).toBe("")
	})
})
