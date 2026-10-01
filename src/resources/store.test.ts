import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { isResourceEnabled, setResourceOverride } from "./store.js"

describe("KIMCHI_ENABLE_RESOURCES", () => {
	let tempDir: string
	let settingsPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-resources-"))
		settingsPath = join(tempDir, "settings.json")
		delete process.env.KIMCHI_ENABLE_RESOURCES
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		delete process.env.KIMCHI_ENABLE_RESOURCES
	})

	it("enables a default-disabled resource", () => {
		expect(isResourceEnabled("extensions.ferment-v2", settingsPath)).toBe(false)
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.ferment-v2"
		expect(isResourceEnabled("extensions.ferment-v2", settingsPath)).toBe(true)
	})

	it("takes multiple comma-separated ids, whitespace-tolerant", () => {
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.memory, extensions.ferment-v2"
		expect(isResourceEnabled("extensions.memory", settingsPath)).toBe(true)
		expect(isResourceEnabled("extensions.ferment-v2", settingsPath)).toBe(true)
	})

	it("drops malformed entries without failing the session", () => {
		process.env.KIMCHI_ENABLE_RESOURCES = ",not a resource id,,extensions.memory,"
		expect(isResourceEnabled("extensions.memory", settingsPath)).toBe(true)
		expect(isResourceEnabled("extensions.ferment-v2", settingsPath)).toBe(false)
	})

	it("a persistent disable wins over the env enable", () => {
		setResourceOverride("extensions.memory", false, settingsPath)
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.memory"
		expect(isResourceEnabled("extensions.memory", settingsPath)).toBe(false)
	})

	it("unknown ids are inert", () => {
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.does-not-exist"
		expect(isResourceEnabled("extensions.memory", settingsPath)).toBe(false)
	})
})
