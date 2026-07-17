import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Real SettingsManager over real temp settings files — only the agent dir
// resolution is redirected, so this exercises the exact resolution path the
// wrapper uses in interactive mode: fetch wrapper → settings watcher → pi's
// scope merge, gated by the watcher's project-trust state.
let currentAgentDir: string
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const original = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()
	return { ...original, getAgentDir: () => currentAgentDir }
})

import { __resetSettingsWatcherForTest, setSettingsProjectTrusted } from "../settings-watcher.js"
import { resolveStreamIdleTimeoutMs, setStreamIdleTimeoutOverride } from "./stream-idle-timeout.js"

const GLOBAL_TIMEOUT_MS = 120_000

let root: string
let projectDir: string
let originalCwd: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kimchi-idle-timeout-settings-"))
	projectDir = join(root, "project")
	currentAgentDir = join(root, "agent")
	mkdirSync(join(projectDir, ".pi"), { recursive: true })
	mkdirSync(currentAgentDir, { recursive: true })
	// Project opts out of the idle timeout; the global scope sets its own value.
	writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 0 }))
	writeFileSync(join(currentAgentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: GLOBAL_TIMEOUT_MS }))

	// The settings watcher reads the project scope from process.cwd().
	originalCwd = process.cwd()
	process.chdir(projectDir)
	__resetSettingsWatcherForTest()
	setStreamIdleTimeoutOverride(undefined)
})

afterEach(() => {
	process.chdir(originalCwd)
	__resetSettingsWatcherForTest()
	rmSync(root, { recursive: true, force: true })
})

describe("project-scoped httpIdleTimeoutMs resolution", () => {
	it("ignores the project opt-out while the project is untrusted", () => {
		expect(resolveStreamIdleTimeoutMs({})).toBe(GLOBAL_TIMEOUT_MS)
	})

	it("honors the project opt-out once trust is synced (the session_start sync path)", () => {
		// Before the sync — e.g. a request racing session start — global scope wins.
		expect(resolveStreamIdleTimeoutMs({})).toBe(GLOBAL_TIMEOUT_MS)

		// settingsTrustSyncExtension performs exactly this call on session_start.
		setSettingsProjectTrusted(true)
		expect(resolveStreamIdleTimeoutMs({})).toBe(0)
	})

	it("drops back to the global value when trust is revoked", () => {
		setSettingsProjectTrusted(true)
		expect(resolveStreamIdleTimeoutMs({})).toBe(0)

		setSettingsProjectTrusted(false)
		expect(resolveStreamIdleTimeoutMs({})).toBe(GLOBAL_TIMEOUT_MS)
	})
})
