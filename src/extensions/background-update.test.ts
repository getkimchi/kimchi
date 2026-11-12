// Tests for the background-update extension: gates, tick scheduling, the
// update notice, and tick-loop lifecycle. runUpdateTick itself is covered in
// src/update/background.test.ts — here we observe the extension boundary.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TickResult } from "../update/background.js"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"

const runUpdateTickMock = vi.fn<() => Promise<TickResult>>()
const getVersionMock = vi.fn(() => "0.0.22")
const isHomebrewInstallMock = vi.fn(() => false)
const loadAutoUpdateSettingMock = vi.fn(() => true)
const loadAutoUpdateNoticeShownMock = vi.fn(() => true)
const readInstalledVersionMock = vi.fn<() => string | null>(() => null)
const cliArgsMock = vi.fn<() => { options: Record<string, unknown>; positionals: string[] }>(() => ({
	options: {},
	positionals: [],
}))

vi.mock("../update/background.js", () => ({
	runUpdateTick: (...args: unknown[]) => runUpdateTickMock(...(args as [])),
}))
vi.mock("../update/settings.js", () => ({
	loadAutoUpdateSetting: () => loadAutoUpdateSettingMock(),
	loadAutoUpdateNoticeShown: () => loadAutoUpdateNoticeShownMock(),
}))
vi.mock("../update/paths.js", async (importOriginal) => {
	// isPackagedBinaryExecPath is pure (no I/O): keep the real one so the
	// packaged-binary gate tests exercise it; mock only the Homebrew probe.
	const actual = await importOriginal<typeof import("../update/paths.js")>()
	return {
		...actual,
		isHomebrewInstall: () => isHomebrewInstallMock(),
	}
})
vi.mock(import("../update/workflow.js"), async (importOriginal) => ({
	...(await importOriginal()),
	readInstalledVersion: () => readInstalledVersionMock(),
}))
vi.mock("../utils.js", () => ({
	getVersion: () => getVersionMock(),
}))
vi.mock("../cli-args.js", () => ({
	getParsedCliArgs: () => cliArgsMock(),
}))

const {
	default: backgroundUpdateExtension,
	evaluateGates,
	UPDATE_INSTALLED_STATUS,
} = await import("./background-update.js")

function goodEnv(): Parameters<typeof evaluateGates>[0] {
	return {
		noAutoUpdate: false,
		version: "0.0.22",
		execPath: "/usr/local/bin/kimchi",
		platform: "darwin",
		isHomebrew: false,
		autoUpdateEnabled: true,
		noticeShown: true,
		updatesDisabled: false,
	}
}

describe("evaluateGates", () => {
	it("allows the background updater when nothing blocks it", () => {
		expect(evaluateGates(goodEnv())).toBeNull()
	})

	it.each([
		["updatesDisabled", { updatesDisabled: true }],
		["--no-auto-update", { noAutoUpdate: true }],
		["homebrew", { isHomebrew: true }],
		["canary", { version: "0.0.0-canary.20260509.abc1234" }],
		["dev version", { version: "dev" }],
		["unknown version", { version: "unknown" }],
		["non-packaged binary", { execPath: "/usr/local/bin/node" }],
		["autoUpdate setting off", { autoUpdateEnabled: false }],
	] as const)("blocks with a static gate when %s", (_reason, patch) => {
		const gate = evaluateGates({ ...goodEnv(), ...patch })
		expect(gate).not.toBeNull()
		expect(gate?.dynamic).toBe(false)
	})

	it("blocks with a dynamic gate when the consent notice is not yet shown", () => {
		const gate = evaluateGates({ ...goodEnv(), noticeShown: false })
		expect(gate?.dynamic).toBe(true)
	})

	it("accepts a packaged binary on Windows paths", () => {
		expect(evaluateGates({ ...goodEnv(), platform: "win32", execPath: "C:\\Users\\a\\AppData\\kimchi.exe" })).toBeNull()
	})

	it("blocks a non-packaged binary on Windows paths", () => {
		expect(
			evaluateGates({ ...goodEnv(), platform: "win32", execPath: "C:\\Program Files\\nodejs\\node.exe" })?.reason,
		).toBe("non-packaged-binary")
	})
})

describe("backgroundUpdateExtension", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		runUpdateTickMock.mockReset()
		runUpdateTickMock.mockResolvedValue({ outcome: "no-update" })
		getVersionMock.mockReturnValue("0.0.22")
		isHomebrewInstallMock.mockReturnValue(false)
		loadAutoUpdateSettingMock.mockReturnValue(true)
		loadAutoUpdateNoticeShownMock.mockReturnValue(true)
		cliArgsMock.mockReturnValue({ options: {}, positionals: [] })
		readInstalledVersionMock.mockReturnValue(null)
		vi.spyOn(process, "execPath", "get").mockReturnValue("/usr/local/bin/kimchi")
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	async function startSession(mode: ExtensionContext["mode"] = "tui") {
		const { api, getHandler, getHandlers } = createExtensionApi()
		backgroundUpdateExtension(api)
		const setStatus = vi.fn()
		const ctx = createContext({ mode, hasUI: mode === "tui" || mode === "rpc", ui: { setStatus } })
		await getHandler("session_start")({}, ctx)
		return { shutdown: getHandlers("session_shutdown")[0], setStatus }
	}

	it("runs the first tick ~10 seconds after session start", async () => {
		await startSession()
		expect(runUpdateTickMock).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(runUpdateTickMock).toHaveBeenCalledOnce()
	})

	it("registers --no-auto-update as a boolean flag so pi accepts it at launch", () => {
		const { api } = createExtensionApi()
		backgroundUpdateExtension(api)
		expect(api.registerFlag).toHaveBeenCalledWith("no-auto-update", expect.objectContaining({ type: "boolean" }))
	})

	it("does nothing in RPC mode, which is also how ACP binds extensions, despite having a UI", async () => {
		await startSession("rpc")
		await vi.advanceTimersByTimeAsync(60_000)
		expect(runUpdateTickMock).not.toHaveBeenCalled()
	})

	it("shows the update notice at session start when a newer release is already installed", async () => {
		// Covers /new: pi clears statuses on session replacement, and the notice
		// must not wait for a tick (which needs the lock and possibly the network).
		readInstalledVersionMock.mockReturnValue("0.0.23")
		const { setStatus } = await startSession()
		expect(setStatus).toHaveBeenCalledWith(UPDATE_INSTALLED_STATUS.key, UPDATE_INSTALLED_STATUS.text)
	})

	it.each([
		["no-update", { outcome: "no-update" }],
		["skipped-lock", { outcome: "skipped-lock" }],
	] as const)("shows the update notice when another session installed during a %s tick", async (_name, result) => {
		const { setStatus } = await startSession()
		expect(setStatus).not.toHaveBeenCalled()
		readInstalledVersionMock.mockReturnValue("0.0.23")
		runUpdateTickMock.mockResolvedValue(result)
		await vi.advanceTimersByTimeAsync(10_000)
		expect(setStatus).toHaveBeenCalledWith(UPDATE_INSTALLED_STATUS.key, UPDATE_INSTALLED_STATUS.text)
	})

	it("shows the update notice within a minute when another session finishes installing between ticks", async () => {
		// Two sessions started together tick together: the loser gets skipped-lock
		// and reads the old version just before the winner's install completes.
		runUpdateTickMock.mockResolvedValue({ outcome: "skipped-lock" })
		const { setStatus } = await startSession()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(setStatus).not.toHaveBeenCalled()

		readInstalledVersionMock.mockReturnValue("0.0.23")
		await vi.advanceTimersByTimeAsync(60_000)
		expect(setStatus).toHaveBeenCalledWith(UPDATE_INSTALLED_STATUS.key, UPDATE_INSTALLED_STATUS.text)
		expect(runUpdateTickMock).toHaveBeenCalledOnce()
	})

	it("stops checking the installed version after session shutdown", async () => {
		const { shutdown, setStatus } = await startSession()
		await shutdown({}, createContext())
		readInstalledVersionMock.mockReturnValue("0.0.23")
		await vi.advanceTimersByTimeAsync(5 * 60_000)
		expect(setStatus).not.toHaveBeenCalled()
	})

	it("stops checking the installed version once the notice is showing", async () => {
		readInstalledVersionMock.mockReturnValue("0.0.23")
		await startSession()
		const readsAtStart = readInstalledVersionMock.mock.calls.length
		await vi.advanceTimersByTimeAsync(5 * 60_000)
		// Only the first tick (at 10s) may read it again; no once-a-minute reads.
		expect(readInstalledVersionMock.mock.calls.length).toBeLessThanOrEqual(readsAtStart + 1)
	})

	it("keeps ticking after another session's install, so a later release is still installed", async () => {
		readInstalledVersionMock.mockReturnValue("0.0.23")
		await startSession()
		await vi.advanceTimersByTimeAsync(10_000)
		await vi.advanceTimersByTimeAsync(30 * 60_000)
		expect(runUpdateTickMock).toHaveBeenCalledTimes(2)
	})

	it("shows no notice when the installed version matches the running one", async () => {
		readInstalledVersionMock.mockReturnValue("0.0.22")
		const { setStatus } = await startSession()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(setStatus).not.toHaveBeenCalled()
	})

	it("does nothing when the session has no UI", async () => {
		await startSession("print")
		await vi.advanceTimersByTimeAsync(60_000)
		expect(runUpdateTickMock).not.toHaveBeenCalled()
	})

	it("does not schedule when a gate blocks it (homebrew example)", async () => {
		isHomebrewInstallMock.mockReturnValue(true)
		await startSession()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(runUpdateTickMock).not.toHaveBeenCalled()
	})

	it("does not schedule with --no-auto-update in parsed CLI args", async () => {
		cliArgsMock.mockReturnValue({ options: { "no-auto-update": true }, positionals: [] })
		await startSession()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(runUpdateTickMock).not.toHaveBeenCalled()
	})

	it("schedules on a first-ever session and lets the tick decide (notice gate is dynamic)", async () => {
		// startup-update marks the notice DURING this same session_start; the
		// background handler may run before that mark, so the schedule-time
		// check must tolerate the dynamic gate. At tick time it is marked.
		loadAutoUpdateNoticeShownMock.mockReturnValue(false)
		await startSession()
		loadAutoUpdateNoticeShownMock.mockReturnValue(true)
		await vi.advanceTimersByTimeAsync(10_000)
		expect(runUpdateTickMock).toHaveBeenCalledOnce()
	})

	it("ticks nothing while the consent notice stays unseen", async () => {
		loadAutoUpdateNoticeShownMock.mockReturnValue(false)
		await startSession()
		await vi.advanceTimersByTimeAsync(70 * 60_000)
		expect(runUpdateTickMock).not.toHaveBeenCalled()
	})

	it("repeats every 30 minutes", async () => {
		await startSession()
		await vi.advanceTimersByTimeAsync(10_000 + 90 * 60_000)
		// first tick + 3 interval ticks (at 10s, 30m+10s, 60m+10s, 90m+10s)
		expect(runUpdateTickMock).toHaveBeenCalledTimes(4)
	})

	it("shows the update notice after a successful install and stops ticking", async () => {
		runUpdateTickMock.mockResolvedValue({ outcome: "installed", version: "v0.0.23" })
		const { setStatus } = await startSession()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(setStatus).toHaveBeenCalledWith(UPDATE_INSTALLED_STATUS.key, UPDATE_INSTALLED_STATUS.text)
		// Session already installed this version; checking again would reinstall it.
		await vi.advanceTimersByTimeAsync(120 * 60_000)
		expect(runUpdateTickMock).toHaveBeenCalledOnce()
	})

	it("stays silent on failure and retries on schedule", async () => {
		runUpdateTickMock.mockResolvedValue({ outcome: "install-failed", version: "v0.0.23", error: "boom" })
		const { setStatus } = await startSession()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(setStatus).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(30 * 60_000)
		expect(runUpdateTickMock).toHaveBeenCalledTimes(2)
	})

	it("stops ticking when auto-update is flipped off mid-session", async () => {
		await startSession()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(runUpdateTickMock).toHaveBeenCalledOnce()
		loadAutoUpdateSettingMock.mockReturnValue(false)
		await vi.advanceTimersByTimeAsync(90 * 60_000)
		expect(runUpdateTickMock).toHaveBeenCalledOnce()
	})

	it("registers its shutdown handler at load, since a first handler added later never fires", async () => {
		const { api, getHandler, getHandlers } = createExtensionApi()
		backgroundUpdateExtension(api)
		expect(getHandlers("session_shutdown")).toHaveLength(1)

		await getHandler("session_start")({}, createContext({ mode: "tui", hasUI: true, ui: { setStatus: vi.fn() } }))

		expect(getHandlers("session_shutdown")).toHaveLength(1)
	})

	it("clears timers on session shutdown", async () => {
		const { shutdown } = await startSession()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(runUpdateTickMock).toHaveBeenCalledOnce()
		if (!shutdown) throw new Error("no session_shutdown handler")
		await shutdown({}, createContext())
		await vi.advanceTimersByTimeAsync(90 * 60_000)
		expect(runUpdateTickMock).toHaveBeenCalledOnce()
	})

	it("sets no status when the session shut down mid-tick", async () => {
		let resolveTick: ((r: TickResult) => void) | undefined
		runUpdateTickMock.mockReturnValue(new Promise((resolve) => (resolveTick = resolve)))
		const { shutdown, setStatus } = await startSession()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(runUpdateTickMock).toHaveBeenCalledOnce()
		if (!shutdown) throw new Error("no session_shutdown handler")
		await shutdown({}, createContext())
		// The in-flight tick settles after shutdown.
		resolveTick?.({ outcome: "installed", version: "v0.0.23" })
		await vi.advanceTimersByTimeAsync(0)
		expect(setStatus).not.toHaveBeenCalled()
	})
})
