import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyOneTimeFullscreenSwitch, type OneTimeFullscreenSwitchOptions } from "./tui-one-time-fullscreen.js"

let tempDir: string
let agentDir: string
let cwd: string
let cacheDir: string

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "kimchi-one-time-fullscreen-"))
	agentDir = join(tempDir, "agent")
	cwd = join(tempDir, "work")
	cacheDir = join(tempDir, "cache")
	mkdirSync(agentDir, { recursive: true })
	mkdirSync(cwd, { recursive: true })
	vi.stubEnv("XDG_CACHE_HOME", cacheDir)
	writeLatestCache()
})

afterEach(() => {
	vi.unstubAllEnvs()
	rmSync(tempDir, { recursive: true, force: true })
})

function writeLatestCache(version = "v1.2.3"): void {
	mkdirSync(join(cacheDir, "kimchi"), { recursive: true })
	writeFileSync(
		join(cacheDir, "kimchi", "state.json"),
		JSON.stringify({
			repos: { "getkimchi/kimchi": { checked_at: new Date().toISOString(), latest_version: version } },
		}),
	)
}

function readSettings(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as Record<string, unknown>
}

function runMigration(overrides: Partial<OneTimeFullscreenSwitchOptions> = {}) {
	return applyOneTimeFullscreenSwitch({
		args: [],
		isTerminalUi: true,
		agentDir,
		cwd,
		currentVersion: "1.2.3",
		...overrides,
	})
}

describe("applyOneTimeFullscreenSwitch", () => {
	it("persists fullscreen globally once and honors a later return to regular", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "regular", theme: "dark" }))
		const args = ["--", "hello"]

		expect(await runMigration({ args })).toBe(args)
		expect(readSettings()).toEqual({ tuiMode: "fullscreen", theme: "dark" })
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(true)

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "regular", theme: "dark" }))
		vi.stubEnv("XDG_CACHE_HOME", join(tempDir, "no-cache"))
		const laterArgs = ["--tui-mode", "regular"]
		expect(await runMigration({ args: laterArgs })).toBe(laterArgs)
		expect(readSettings()).toEqual({ tuiMode: "regular", theme: "dark" })
	})

	it("does not claim completion when already starting fullscreen", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "fullscreen" }))
		const args: string[] = []
		expect(await runMigration({ args })).toBe(args)
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(false)
	})

	it("honors an explicit regular CLI override and later leads to the saved mode only", async () => {
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

	it.each([
		{ name: "newer release available", latestVersion: "v1.2.4", emptyCache: false, noUpdateCheck: false },
		{ name: "cached release older than current", latestVersion: "v1.2.2", emptyCache: false, noUpdateCheck: false },
		{ name: "missing cache", latestVersion: "v1.2.3", emptyCache: true, noUpdateCheck: false },
		{ name: "update checks disabled", latestVersion: "v1.2.3", emptyCache: false, noUpdateCheck: true },
	])("skips migration with $name", async ({ latestVersion, emptyCache, noUpdateCheck }) => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "regular" }))
		if (latestVersion !== "v1.2.3") writeLatestCache(latestVersion)
		if (emptyCache) vi.stubEnv("XDG_CACHE_HOME", join(tempDir, "no-cache"))
		vi.stubEnv("KIMCHI_NO_UPDATE_CHECK", noUpdateCheck ? "1" : "")
		const args: string[] = []

		expect(await runMigration({ args })).toBe(args)
		expect(readSettings()).toEqual({ tuiMode: "regular" })
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(false)
	})

	it("does not crash or claim completion for unreadable settings", async () => {
		writeFileSync(join(agentDir, "settings.json"), "not json")
		await expect(runMigration()).resolves.toEqual([])
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(false)
	})
})
