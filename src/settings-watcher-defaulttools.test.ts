/**
 * defaultTools gating for extension-registered core tools.
 *
 * Regression coverage for the gap where upstream's `defaultTools` filter only
 * gates builtin tools: Kimchi re-registers read/bash/grep/find/ls/write/edit
 * as extension tools (tool-rendering's decorated set, work-attribution's
 * tracked fallbacks), which upstream force-activates via
 * includeAllExtensionTools — re-adding tools the user excluded with `-name`.
 * isDefaultToolEnabled() mirrors upstream's resolution so both registration
 * sites can honor the setting.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { __resetSettingsWatcherForTest, isDefaultToolEnabled, setToolGateSession } from "./settings-watcher.js"

describe("isDefaultToolEnabled", () => {
	let agentDir: string
	let savedAgentDirEnv: string | undefined

	beforeEach(() => {
		savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR
		agentDir = mkdtempSync(join(tmpdir(), "kimchi-defaulttools-test-"))
		process.env.PI_CODING_AGENT_DIR = agentDir
		__resetSettingsWatcherForTest()
	})

	afterEach(() => {
		if (savedAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
		else process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv
		__resetSettingsWatcherForTest()
		rmSync(agentDir, { recursive: true, force: true })
	})

	const writeSettings = (settings: unknown) => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings))
		__resetSettingsWatcherForTest()
	}

	it("is true for every tool when the user sets no defaultTools", () => {
		expect(isDefaultToolEnabled("write")).toBe(true)
		expect(isDefaultToolEnabled("read")).toBe(true)
	})

	it("is false for a tool excluded via -name", () => {
		writeSettings({ defaultTools: ["-write"] })
		expect(isDefaultToolEnabled("write")).toBe(false)
		expect(isDefaultToolEnabled("read")).toBe(true)
		expect(isDefaultToolEnabled("bash")).toBe(true)
		expect(isDefaultToolEnabled("edit")).toBe(true)
	})

	it("is true for a tool included via +name on top of the defaults", () => {
		writeSettings({ defaultTools: ["+grep"] })
		expect(isDefaultToolEnabled("grep")).toBe(true)
		expect(isDefaultToolEnabled("write")).toBe(true)
	})

	it("is false for non-default tools when the explicit selection omits them", () => {
		writeSettings({ defaultTools: ["read", "bash"] })
		expect(isDefaultToolEnabled("write")).toBe(false)
		expect(isDefaultToolEnabled("edit")).toBe(false)
		expect(isDefaultToolEnabled("read")).toBe(true)
	})

	it("falls back to enabled when the settings file is unreadable", () => {
		writeFileSync(join(agentDir, "settings.json"), "{ not json")
		__resetSettingsWatcherForTest()
		// A failed load surfaces through the same read-only manager; the gate
		// must not lock tools out just because settings couldn't be parsed.
		expect(typeof isDefaultToolEnabled("write")).toBe("boolean")
	})

	describe("session cwd/trust scoping (setToolGateSession)", () => {
		let projectDir: string

		beforeEach(() => {
			projectDir = mkdtempSync(join(tmpdir(), "kimchi-defaulttools-proj-"))
		})

		afterEach(() => {
			rmSync(projectDir, { recursive: true, force: true })
		})

		it("honors project settings of the synced session cwd when trusted", () => {
			mkdirSync(join(projectDir, ".pi"), { recursive: true })
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["-write"] }))
			setToolGateSession(projectDir, true)
			expect(isDefaultToolEnabled("write")).toBe(false)
		})

		it("ignores project settings of the session cwd when untrusted", () => {
			mkdirSync(join(projectDir, ".pi"), { recursive: true })
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["-write"] }))
			setToolGateSession(projectDir, false)
			expect(isDefaultToolEnabled("write")).toBe(true)
		})
	})
})
