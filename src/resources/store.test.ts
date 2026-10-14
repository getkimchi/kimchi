import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	getResourceOverride,
	isResourceEnabled,
	onTerminalRecordingChange,
	resetResourceOverride,
	setResourceOverride,
} from "./store.js"

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

	it("uses terminalRecording as the recording resource's single persisted setting", () => {
		const id = "extensions.terminal-recording"
		expect(isResourceEnabled(id, settingsPath)).toBe(true)
		writeFileSync(settingsPath, JSON.stringify({ terminalRecording: false, theme: "dark" }))
		expect(getResourceOverride(id, settingsPath)).toBe(false)
		expect(isResourceEnabled(id, settingsPath)).toBe(false)
		setResourceOverride(id, true, settingsPath)
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ terminalRecording: true, theme: "dark" })
		expect(isResourceEnabled(id, settingsPath)).toBe(true)
		resetResourceOverride(id, settingsPath)
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ theme: "dark" })
		expect(getResourceOverride(id, settingsPath)).toBeUndefined()
		expect(isResourceEnabled(id, settingsPath)).toBe(true)
	})

	it("honors an existing recording disable and removes a conflicting nested override on change", () => {
		const id = "extensions.terminal-recording"
		writeFileSync(
			settingsPath,
			JSON.stringify({ terminalRecording: false, resources: { [id]: true, "hooks.bash": false } }),
		)
		expect(isResourceEnabled(id, settingsPath)).toBe(false)
		setResourceOverride(id, true, settingsPath)
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
			terminalRecording: true,
			resources: { "hooks.bash": false },
		})
	})

	it("notifies live recording only after its setting is persisted", () => {
		const listener = vi.fn((path: string) => {
			expect(JSON.parse(readFileSync(path, "utf8")).terminalRecording).toBe(false)
		})
		const unsubscribe = onTerminalRecordingChange(listener)
		try {
			setResourceOverride("hooks.bash", false, settingsPath)
			expect(listener).not.toHaveBeenCalled()
			setResourceOverride("extensions.terminal-recording", false, settingsPath)
			expect(listener).toHaveBeenCalledExactlyOnceWith(settingsPath)
		} finally {
			unsubscribe()
		}
		setResourceOverride("extensions.terminal-recording", true, settingsPath)
		expect(listener).toHaveBeenCalledOnce()
	})
})
