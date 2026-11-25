import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs as parsePiArgs } from "@earendil-works/pi-coding-agent"
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
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "regular" }))
})

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true })
})

function latestStable() {
	return { hasUpdate: false, latestVersion: "v1.2.3", tag: "v1.2.3" }
}

function runSwitch(overrides: Partial<OneTimeFullscreenSwitchOptions> = {}) {
	return applyOneTimeFullscreenSwitch({
		args: [],
		isTerminalUi: true,
		agentDir,
		cwd,
		currentVersion: "1.2.3",
		checkForUpdate: vi.fn().mockResolvedValue(latestStable()),
		...overrides,
	})
}

describe("applyOneTimeFullscreenSwitch", () => {
	it("automatically switches a confirmed-latest regular TUI without rewriting the saved mode", async () => {
		const checkForUpdate = vi.fn().mockResolvedValue(latestStable())

		const args = await applyOneTimeFullscreenSwitch({
			args: ["--", "hello"],
			isTerminalUi: true,
			agentDir,
			cwd,
			currentVersion: "1.2.3",
			checkForUpdate,
		})

		expect(parsePiArgs(args).tuiMode).toBe("fullscreen")
		expect(parsePiArgs(args).messages).toEqual(["hello"])
		expect(checkForUpdate).toHaveBeenCalledWith({ currentVersion: "1.2.3", skipCache: false, canary: false })
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"))).toEqual({ tuiMode: "regular" })
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(true)
	})

	it("does not switch or check again after completion, including after the user returns to regular mode", async () => {
		const firstCheck = vi.fn().mockResolvedValue(latestStable())
		expect(parsePiArgs(await runSwitch({ checkForUpdate: firstCheck })).tuiMode).toBe("fullscreen")

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "regular" }))
		const laterCheck = vi.fn().mockResolvedValue(latestStable())
		const laterArgs = ["--tui-mode", "regular"]

		expect(await runSwitch({ args: laterArgs, checkForUpdate: laterCheck })).toBe(laterArgs)
		expect(laterCheck).not.toHaveBeenCalled()
	})

	it("does nothing when the session already starts fullscreen", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "fullscreen" }))
		const args: string[] = []
		const checkForUpdate = vi.fn().mockResolvedValue(latestStable())
		expect(await runSwitch({ args, checkForUpdate })).toBe(args)
		expect(checkForUpdate).not.toHaveBeenCalled()
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(false)
	})

	it("preserves an explicit fullscreen CLI override without checking or claiming completion", async () => {
		const args = ["--tui-mode", "fullscreen"]
		const checkForUpdate = vi.fn().mockResolvedValue(latestStable())
		expect(await runSwitch({ args, checkForUpdate })).toBe(args)
		expect(checkForUpdate).not.toHaveBeenCalled()
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(false)
	})

	it("does nothing for ACP, print, protocol, and other non-TUI launches", async () => {
		const args = ["--mode", "acp"]
		const checkForUpdate = vi.fn().mockResolvedValue(latestStable())
		expect(await runSwitch({ args, isTerminalUi: false, checkForUpdate })).toBe(args)
		expect(checkForUpdate).not.toHaveBeenCalled()
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(false)
	})

	it("does not switch when an update is available", async () => {
		const args: string[] = []
		const checkForUpdate = vi.fn().mockResolvedValue({ hasUpdate: true, latestVersion: "v1.2.4", tag: "v1.2.4" })
		expect(await runSwitch({ args, checkForUpdate })).toBe(args)
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(false)
	})

	it("does not switch when the current version is newer than the latest release", async () => {
		const args: string[] = []
		const checkForUpdate = vi.fn().mockResolvedValue({ hasUpdate: false, latestVersion: "v1.2.2", tag: "v1.2.2" })
		expect(await runSwitch({ args, checkForUpdate })).toBe(args)
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(false)
	})

	it("does not switch when the update check fails", async () => {
		const args: string[] = []
		const checkForUpdate = vi.fn().mockRejectedValue(new Error("offline"))
		expect(await runSwitch({ args, checkForUpdate })).toBe(args)
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(false)
	})

	it("does not treat a disabled update check as latest-version confirmation", async () => {
		const args: string[] = []
		const checkForUpdate = vi.fn().mockResolvedValue({ hasUpdate: false, latestVersion: "1.2.3", tag: "" })
		expect(await runSwitch({ args, checkForUpdate })).toBe(args)
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(false)
	})

	it("does not switch when completion cannot be persisted", async () => {
		const args: string[] = []
		const checkForUpdate = vi.fn().mockImplementation(async () => {
			rmSync(agentDir, { recursive: true, force: true })
			writeFileSync(agentDir, "not a directory")
			return latestStable()
		})
		expect(await runSwitch({ args, checkForUpdate })).toBe(args)
		expect(existsSync(join(agentDir, "one-time-fullscreen.json"))).toBe(false)
	})

	it("does not switch when another launch claims completion during the update check", async () => {
		const args: string[] = []
		const statePath = join(agentDir, "one-time-fullscreen.json")
		const checkForUpdate = vi.fn().mockImplementation(async () => {
			writeFileSync(statePath, "{}")
			return latestStable()
		})
		expect(await runSwitch({ args, checkForUpdate })).toBe(args)
		expect(readFileSync(statePath, "utf-8")).toBe("{}")
	})

	it("checks the canary track and accepts the latest build of the current commit", async () => {
		const currentVersion = "0.0.0-canary.20261125.abc1234"
		const checkForUpdate = vi.fn().mockResolvedValue({
			hasUpdate: false,
			latestVersion: "0.0.0-canary.20261126.abc1234",
			tag: "canary",
		})

		const args = await runSwitch({ currentVersion, checkForUpdate })

		expect(parsePiArgs(args).tuiMode).toBe("fullscreen")
		expect(checkForUpdate).toHaveBeenCalledWith({ currentVersion, skipCache: false, canary: true })
	})
})
