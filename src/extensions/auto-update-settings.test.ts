// Tests for src/extensions/auto-update-settings.ts.
//
// Strategy: focus on `runManualUpdate()` + the re-exports. The TUI menu
// handler is thin glue over `ctx.ui.select` / `ctx.ui.notify` from
// @earendil-works/pi-coding-agent and is exercised manually in the
// harness itself — booting the TUI in vitest is out of scope.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockCheckForUpdate = vi.fn()
const mockApplyUpdate = vi.fn()
const mockLoadAutoUpdateSetting = vi.fn(() => true)
const mockLoadAutoUpdateNoticeShown = vi.fn(() => false)
const mockMarkAutoUpdateNoticeShown = vi.fn()
const mockSaveAutoUpdateSetting = vi.fn()
const mockIsHomebrewInstall = vi.fn(() => false)
const mockGetVersion = vi.fn(() => "1.0.0")

vi.mock("../update/paths.js", () => ({
	isHomebrewInstall: mockIsHomebrewInstall,
}))
vi.mock("../update/settings.js", () => ({
	loadAutoUpdateSetting: mockLoadAutoUpdateSetting,
	saveAutoUpdateSetting: mockSaveAutoUpdateSetting,
	loadAutoUpdateNoticeShown: mockLoadAutoUpdateNoticeShown,
	markAutoUpdateNoticeShown: mockMarkAutoUpdateNoticeShown,
}))
vi.mock("../update/workflow.js", () => ({
	checkForUpdate: mockCheckForUpdate,
	applyUpdate: mockApplyUpdate,
}))
vi.mock("../utils.js", () => ({
	getVersion: mockGetVersion,
}))

// Imports must come AFTER the vi.mock calls.
const extension = await import("./auto-update-settings.js")
const {
	runManualUpdate,
	argvHasSkipTrigger,
	loadAutoUpdateSetting,
	saveAutoUpdateSetting,
	loadAutoUpdateNoticeShown,
	markAutoUpdateNoticeShown,
	default: defaultExport,
} = extension

function resetMocks(): void {
	mockCheckForUpdate.mockReset()
	mockApplyUpdate.mockReset()
	mockLoadAutoUpdateSetting.mockReset()
	mockLoadAutoUpdateNoticeShown.mockReset()
	mockMarkAutoUpdateNoticeShown.mockReset()
	mockSaveAutoUpdateSetting.mockReset()
	mockIsHomebrewInstall.mockReset()
	mockGetVersion.mockReset()
	mockLoadAutoUpdateSetting.mockReturnValue(true)
	mockLoadAutoUpdateNoticeShown.mockReturnValue(false)
	mockIsHomebrewInstall.mockReturnValue(false)
	mockGetVersion.mockReturnValue("1.0.0")
	mockCheckForUpdate.mockResolvedValue({
		currentVersion: "1.0.0",
		latestVersion: "1.0.0",
		tag: "v1.0.0",
		releaseUrl: "",
		hasUpdate: false,
		cached: false,
	})
}

beforeEach(() => {
	resetMocks()
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("re-exports delegate to the underlying modules", () => {
	it("loadAutoUpdateSetting delegates to settings.loadAutoUpdateSetting", () => {
		mockLoadAutoUpdateSetting.mockReturnValue(true)
		expect(loadAutoUpdateSetting()).toBe(true)
		expect(mockLoadAutoUpdateSetting).toHaveBeenCalledOnce()
	})

	it("saveAutoUpdateSetting delegates to settings.saveAutoUpdateSetting", () => {
		saveAutoUpdateSetting(false)
		expect(mockSaveAutoUpdateSetting).toHaveBeenCalledWith(false)
	})

	it("loadAutoUpdateNoticeShown delegates to settings.loadAutoUpdateNoticeShown", () => {
		mockLoadAutoUpdateNoticeShown.mockReturnValue(true)
		expect(loadAutoUpdateNoticeShown()).toBe(true)
		expect(mockLoadAutoUpdateNoticeShown).toHaveBeenCalledOnce()
	})

	it("markAutoUpdateNoticeShown delegates to settings.markAutoUpdateNoticeShown", () => {
		markAutoUpdateNoticeShown()
		expect(mockMarkAutoUpdateNoticeShown).toHaveBeenCalledOnce()
	})
})

describe("argvHasSkipTrigger re-export sanity", () => {
	it("returns true for `kimchi update`", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "update"])).toBe(true)
	})

	it("returns true for `--no-auto-update` flag", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "--no-auto-update"])).toBe(true)
	})

	it("returns false for a plain TUI launch", () => {
		expect(argvHasSkipTrigger(["node", "kimchi"])).toBe(false)
	})
})

describe("auto-update setting reflects in the toggle label state", () => {
	// The menu label ("Auto-update: ON" / "OFF") is built inline in
	// autoUpdateLabel() from loadAutoUpdateSetting(). We assert the
	// underlying state the label consumes — which is the same guarantee
	// the menu handler relies on. Booting the TUI select list in vitest
	// is out of scope.

	it("returns true when the toggle is on — label would read 'Auto-update: ON'", () => {
		mockLoadAutoUpdateSetting.mockReturnValue(true)
		expect(loadAutoUpdateSetting()).toBe(true)
	})

	it("returns false after saveAutoUpdateSetting(false) — label would read 'Auto-update: OFF'", () => {
		mockLoadAutoUpdateSetting.mockReturnValueOnce(false)
		// Simulate the toggle handler calling save then re-reading:
		saveAutoUpdateSetting(false)
		expect(mockSaveAutoUpdateSetting).toHaveBeenCalledWith(false)
		expect(loadAutoUpdateSetting()).toBe(false)
	})
})

describe("runManualUpdate — happy path", () => {
	it("calls checkForUpdate with skipCache: true and canary: false", async () => {
		mockCheckForUpdate.mockResolvedValue({
			currentVersion: "1.0.0",
			latestVersion: "1.0.0",
			tag: "v1.0.0",
			releaseUrl: "",
			hasUpdate: false,
			cached: false,
		})
		await runManualUpdate()
		expect(mockCheckForUpdate).toHaveBeenCalledWith({
			currentVersion: "1.0.0",
			skipCache: true,
			canary: false,
		})
	})

	it("returns {ok: true, message: 'Already up to date ...'} when hasUpdate is false", async () => {
		mockCheckForUpdate.mockResolvedValue({
			currentVersion: "1.0.0",
			latestVersion: "1.0.0",
			tag: "v1.0.0",
			releaseUrl: "",
			hasUpdate: false,
			cached: false,
		})
		const result = await runManualUpdate()
		expect(result).toEqual({ ok: true, message: "Already up to date (1.0.0)" })
		expect(mockApplyUpdate).not.toHaveBeenCalled()
	})

	it("calls applyUpdate({tag}) when an update is available and returns success", async () => {
		mockCheckForUpdate.mockResolvedValue({
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
			tag: "v1.1.0",
			releaseUrl: "https://example/v1.1.0",
			hasUpdate: true,
			cached: false,
		})
		mockApplyUpdate.mockResolvedValue({ from: "1.0.0", to: "1.1.0", backupPath: undefined })

		const result = await runManualUpdate()
		expect(mockApplyUpdate).toHaveBeenCalledWith({ tag: "v1.1.0" })
		expect(result.ok).toBe(true)
		expect(result.message).toContain("1.1.0")
		expect(result.message).toContain("Restart your terminal")
	})
})

describe("runManualUpdate — failure paths", () => {
	it("returns {ok: false, ...} when applyUpdate throws and does not rethrow", async () => {
		mockCheckForUpdate.mockResolvedValue({
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
			tag: "v1.1.0",
			releaseUrl: "",
			hasUpdate: true,
			cached: false,
		})
		mockApplyUpdate.mockRejectedValue(new Error("smoke test failed"))
		const warnSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

		const result = await runManualUpdate()
		expect(result.ok).toBe(false)
		expect(result.message).toBe("Update failed: smoke test failed")
		// We should have written a log line so the failure is visible.
		expect(warnSpy).toHaveBeenCalled()
		const written = warnSpy.mock.calls.map((c) => String(c[0])).join("")
		expect(written).toContain("manual update failed")
	})

	it("returns {ok: false, ...} when checkForUpdate throws and does not rethrow", async () => {
		mockCheckForUpdate.mockRejectedValue(new Error("network down"))
		const warnSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

		const result = await runManualUpdate()
		expect(result.ok).toBe(false)
		expect(result.message).toBe("Update check failed: network down")
		expect(mockApplyUpdate).not.toHaveBeenCalled()
		expect(warnSpy).toHaveBeenCalled()
		const written = warnSpy.mock.calls.map((c) => String(c[0])).join("")
		expect(written).toContain("update check failed")
	})
})

describe("default export — extension factory", () => {
	it("is a function that accepts a pi-shaped object and registers an `update` command", () => {
		expect(typeof defaultExport).toBe("function")
		const commands: Array<{ name: string; options: { description: string; handler: unknown } }> = []
		const fakePi = {
			registerCommand: (name: string, options: { description: string; handler: (...args: unknown[]) => unknown }) => {
				commands.push({ name, options })
			},
		}
		// biome-ignore lint/suspicious/noExplicitAny: fake pi satisfies the structural surface used by this extension
		defaultExport(fakePi as any)
		expect(commands).toHaveLength(1)
		expect(commands[0]?.name).toBe("update")
		expect(commands[0]?.options.description).toBe("Manage kimchi auto-update")
		expect(typeof commands[0]?.options.handler).toBe("function")
	})
})
