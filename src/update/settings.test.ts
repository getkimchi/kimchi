// Tests for src/update/settings.ts.
//
// Path injection strategy: we mock `@earendil-works/pi-coding-agent` so that
// `getAgentDir()` resolves to a fresh per-test tmpdir. This avoids the
// `forTest` re-export noise and matches the pattern already used by
// src/extensions/agents/discovery-priority.test.ts and friends.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"

// Fake agent dir shared by the mocked getAgentDir(). We rebuild it for every
// test in beforeEach so isolation holds across the suite.
let fakeAgentDir: string

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return { ...actual, getAgentDir: () => fakeAgentDir }
})

// Imports must come AFTER the vi.mock call so the mock is wired up.
const { loadAutoUpdateSetting, saveAutoUpdateSetting, loadAutoUpdateNoticeShown, markAutoUpdateNoticeShown } =
	await import("./settings.js")

const statePath = (): string => join(fakeAgentDir, "auto-update.json")

beforeEach(() => {
	fakeAgentDir = mkdtempSync(join(tmpdir(), "kimchi-update-settings-"))
})

afterEach(() => {
	rmSync(fakeAgentDir, { recursive: true, force: true })
})

describe("loadAutoUpdateSetting", () => {
	it("returns true when the settings file is missing (opt-out default)", () => {
		expect(loadAutoUpdateSetting()).toBe(true)
	})

	it("returns true when the file exists but has no autoUpdate key", () => {
		writeFileSync(statePath(), JSON.stringify({ theme: "dark" }))
		expect(loadAutoUpdateSetting()).toBe(true)
	})

	it("returns false when autoUpdate is explicitly false", () => {
		writeFileSync(statePath(), JSON.stringify({ autoUpdate: false }))
		expect(loadAutoUpdateSetting()).toBe(false)
	})

	it("returns true when autoUpdate is explicitly true", () => {
		writeFileSync(statePath(), JSON.stringify({ autoUpdate: true }))
		expect(loadAutoUpdateSetting()).toBe(true)
	})

	it.each([["yes"], ["false"], [0], [null]])("falls back to the default and warns when autoUpdate is %j", (value) => {
		writeFileSync(statePath(), JSON.stringify({ autoUpdate: value }))
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		onTestFinished(() => warn.mockRestore())

		expect(loadAutoUpdateSetting()).toBe(true)
		expect(warn).toHaveBeenCalledOnce()
		expect(warn.mock.calls[0]?.[0]).toContain("non-boolean autoUpdate")
	})

	it("falls back to the default and warns when the file contains malformed JSON", () => {
		writeFileSync(statePath(), "{not valid json")
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		onTestFinished(() => warn.mockRestore())

		expect(loadAutoUpdateSetting()).toBe(true)
		expect(warn).toHaveBeenCalledOnce()
		expect(warn.mock.calls[0]?.[0]).toContain("[kimchi-update]")
	})
})

describe("saveAutoUpdateSetting", () => {
	it("persists false across reloads", () => {
		saveAutoUpdateSetting(false)
		expect(loadAutoUpdateSetting()).toBe(false)
	})

	it("persists true across reloads", () => {
		saveAutoUpdateSetting(true)
		expect(loadAutoUpdateSetting()).toBe(true)
	})

	it("preserves unrelated keys when writing", () => {
		writeFileSync(statePath(), JSON.stringify({ theme: "dark", autoUpdate: true, autoUpdateNoticeShown: false }))
		saveAutoUpdateSetting(false)
		const round = JSON.parse(readFileSync(statePath(), "utf-8")) as Record<string, unknown>
		expect(round.autoUpdate).toBe(false)
		expect(round.theme).toBe("dark")
		expect(round.autoUpdateNoticeShown).toBe(false)
	})

	it("enabling marks the one-time notice as shown; disabling leaves it alone", () => {
		saveAutoUpdateSetting(false)
		expect(loadAutoUpdateNoticeShown()).toBe(false)

		saveAutoUpdateSetting(true)
		expect(loadAutoUpdateNoticeShown()).toBe(true)
	})

	it("survives two consecutive writes — the last value wins", () => {
		saveAutoUpdateSetting(true)
		saveAutoUpdateSetting(false)
		saveAutoUpdateSetting(true)
		expect(loadAutoUpdateSetting()).toBe(true)
	})

	it("creates the parent directory if it does not exist", () => {
		// fakeAgentDir already exists; remove it to prove mkdirSync runs.
		rmSync(fakeAgentDir, { recursive: true, force: true })
		saveAutoUpdateSetting(false)
		expect(loadAutoUpdateSetting()).toBe(false)
	})
})

describe("loadAutoUpdateNoticeShown", () => {
	it("returns false when the file is missing", () => {
		expect(loadAutoUpdateNoticeShown()).toBe(false)
	})

	it("returns false when the key is absent", () => {
		writeFileSync(statePath(), JSON.stringify({ theme: "dark" }))
		expect(loadAutoUpdateNoticeShown()).toBe(false)
	})

	it("returns true when the key is true", () => {
		writeFileSync(statePath(), JSON.stringify({ autoUpdateNoticeShown: true }))
		expect(loadAutoUpdateNoticeShown()).toBe(true)
	})

	it("returns false when the key is the wrong type", () => {
		writeFileSync(statePath(), JSON.stringify({ autoUpdateNoticeShown: "yes" }))
		expect(loadAutoUpdateNoticeShown()).toBe(false)
	})
})

describe("markAutoUpdateNoticeShown", () => {
	it("flips the notice flag to true", () => {
		writeFileSync(statePath(), JSON.stringify({ autoUpdate: true }))
		markAutoUpdateNoticeShown()
		expect(loadAutoUpdateNoticeShown()).toBe(true)
	})

	it("does not disturb autoUpdate", () => {
		saveAutoUpdateSetting(false)
		markAutoUpdateNoticeShown()
		expect(loadAutoUpdateSetting()).toBe(false)
		expect(loadAutoUpdateNoticeShown()).toBe(true)
	})

	it("preserves unrelated keys", () => {
		writeFileSync(statePath(), JSON.stringify({ theme: "dark", autoUpdate: true }))
		markAutoUpdateNoticeShown()
		const round = JSON.parse(readFileSync(statePath(), "utf-8")) as Record<string, unknown>
		expect(round.autoUpdateNoticeShown).toBe(true)
		expect(round.autoUpdate).toBe(true)
		expect(round.theme).toBe("dark")
	})
})
