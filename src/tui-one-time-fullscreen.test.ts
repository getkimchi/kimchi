import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyOneTimeFullscreenSwitch, type OneTimeFullscreenSwitchOptions } from "./tui-one-time-fullscreen.js"

let tempDir: string
let agentDir: string
let cwd: string

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "kimchi-one-time-fullscreen-"))
	agentDir = join(tempDir, "agent")
	cwd = join(tempDir, "work")
	mkdirSync(agentDir, { recursive: true })
	mkdirSync(cwd, { recursive: true })
})

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true })
})

interface SavedSettings {
	tuiMode?: string
	theme?: string
}

function globalSettingsPath(): string {
	return join(agentDir, "settings.json")
}

function writeGlobalSettings(settings: SavedSettings): void {
	writeFileSync(globalSettingsPath(), JSON.stringify(settings))
}

function writeProjectSettings(settings: SavedSettings): void {
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true })
	writeFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify(settings))
}

function readGlobalSettings(): SavedSettings {
	return JSON.parse(readFileSync(globalSettingsPath(), "utf-8"))
}

function markerExists(): boolean {
	return existsSync(join(agentDir, "one-time-fullscreen.json"))
}

function runSwitch(overrides: Partial<OneTimeFullscreenSwitchOptions> = {}): Promise<void> {
	return applyOneTimeFullscreenSwitch({ args: [], isTerminalUi: true, agentDir, cwd, ...overrides })
}

describe("applyOneTimeFullscreenSwitch", () => {
	it("persists fullscreen globally once and honors a later return to regular", async () => {
		writeGlobalSettings({ tuiMode: "regular", theme: "dark" })

		await runSwitch({ args: ["--", "hello"] })
		expect(readGlobalSettings()).toEqual({ tuiMode: "fullscreen", theme: "dark" })
		expect(markerExists()).toBe(true)

		// A plain relaunch after the user chose regular: only the marker stops a second switch.
		writeGlobalSettings({ tuiMode: "regular", theme: "dark" })
		await runSwitch()
		expect(readGlobalSettings()).toEqual({ tuiMode: "regular", theme: "dark" })
	})

	it("records completion without changing settings when already fullscreen", async () => {
		writeGlobalSettings({ tuiMode: "fullscreen" })
		await runSwitch()
		expect(readGlobalSettings()).toEqual({ tuiMode: "fullscreen" })
		expect(markerExists()).toBe(true)
	})

	it("decides from global settings even when the project sets fullscreen", async () => {
		writeGlobalSettings({ tuiMode: "regular" })
		writeProjectSettings({ tuiMode: "fullscreen" })
		await runSwitch()
		expect(readGlobalSettings()).toEqual({ tuiMode: "fullscreen" })
		expect(markerExists()).toBe(true)
	})

	it("decides from global settings even when the project sets regular", async () => {
		writeGlobalSettings({ tuiMode: "fullscreen" })
		writeProjectSettings({ tuiMode: "regular" })
		await runSwitch()
		expect(readGlobalSettings()).toEqual({ tuiMode: "fullscreen" })
		expect(markerExists()).toBe(true)
	})

	it.each([
		{ name: "explicit regular mode", args: ["--tui-mode", "regular"], isTerminalUi: true },
		{ name: "explicit fullscreen mode", args: ["--tui-mode", "fullscreen"], isTerminalUi: true },
		{ name: "non-TUI", args: ["--mode", "acp"], isTerminalUi: false },
		{ name: "version", args: ["--version"], isTerminalUi: true },
		{ name: "help", args: ["--help"], isTerminalUi: true },
		{ name: "export", args: ["--export", "out.html"], isTerminalUi: true },
		{ name: "model listing", args: ["--list-models"], isTerminalUi: true },
		{ name: "package install", args: ["install", "npm:example"], isTerminalUi: true },
		{ name: "package removal", args: ["uninstall", "npm:example"], isTerminalUi: true },
		{ name: "package listing", args: ["list"], isTerminalUi: true },
		{ name: "auth check", args: ["auth", "check", "--provider", "x"], isTerminalUi: true },
		{ name: "config", args: ["config"], isTerminalUi: true },
		{ name: "mcp", args: ["mcp", "list"], isTerminalUi: true },
	])("leaves settings unchanged and keeps the switch pending for $name launches", async ({ args, isTerminalUi }) => {
		writeGlobalSettings({ tuiMode: "regular" })
		await runSwitch({ args, isTerminalUi })
		expect(readGlobalSettings()).toEqual({ tuiMode: "regular" })
		expect(markerExists()).toBe(false)
	})
})

describe("applyOneTimeFullscreenSwitch failures", () => {
	it("does not crash or claim completion for unreadable settings", async () => {
		writeFileSync(globalSettingsPath(), "not json")
		await expect(runSwitch()).resolves.toBeUndefined()
		expect(markerExists()).toBe(false)
	})

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"removes the marker when the global settings write fails",
		async () => {
			writeGlobalSettings({ tuiMode: "regular" })
			chmodSync(globalSettingsPath(), 0o444)

			await expect(runSwitch()).resolves.toBeUndefined()
			expect(readGlobalSettings()).toEqual({ tuiMode: "regular" })
			expect(markerExists()).toBe(false)
		},
	)
})
