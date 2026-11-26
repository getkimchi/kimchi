import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
	vi.unstubAllEnvs()
	rmSync(tempDir, { recursive: true, force: true })
})

function readSettings(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as Record<string, unknown>
}

function runMigration(overrides: Partial<OneTimeFullscreenSwitchOptions> = {}) {
	return applyOneTimeFullscreenSwitch({ args: [], isTerminalUi: true, agentDir, cwd, ...overrides })
}

describe("applyOneTimeFullscreenSwitch", () => {
	it("persists fullscreen globally once and honors a later return to regular", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "regular", theme: "dark" }))
		const args = ["--", "hello"]
		vi.stubEnv("XDG_CACHE_HOME", join(tempDir, "no-cache"))

		expect(await runMigration({ args })).toBe(args)
		expect(readSettings()).toEqual({ tuiMode: "fullscreen", theme: "dark" })
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(true)

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "regular", theme: "dark" }))
		const laterArgs = ["--tui-mode", "regular"]
		expect(await runMigration({ args: laterArgs })).toBe(laterArgs)
		expect(readSettings()).toEqual({ tuiMode: "regular", theme: "dark" })
	})

	it("records completion without changing settings when already fullscreen", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "fullscreen" }))
		const args: string[] = []
		expect(await runMigration({ args })).toBe(args)
		expect(readSettings()).toEqual({ tuiMode: "fullscreen" })
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(true)
	})

	it("respects an explicit regular CLI override without claiming completion", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "regular" }))
		const args = ["--tui-mode", "regular"]
		expect(await runMigration({ args })).toBe(args)
		expect(readSettings()).toEqual({ tuiMode: "regular" })
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(false)
	})

	it.each([
		{ name: "non-TUI", args: ["--mode", "acp"], isTerminalUi: false },
		{ name: "version", args: ["--version"], isTerminalUi: true },
		{ name: "export", args: ["--export", "out.html"], isTerminalUi: true },
	])("skips $name launches without changing settings or claiming completion", async ({ args, isTerminalUi }) => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "regular" }))
		expect(await runMigration({ args, isTerminalUi })).toBe(args)
		expect(readSettings()).toEqual({ tuiMode: "regular" })
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(false)
	})

	it("does not crash or claim completion for unreadable settings", async () => {
		writeFileSync(join(agentDir, "settings.json"), "not json")
		await expect(runMigration()).resolves.toEqual([])
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(false)
	})
})
