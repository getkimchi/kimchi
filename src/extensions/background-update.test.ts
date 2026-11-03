// Tests for the background-update extension: gates, tick scheduling, the
// update notice, and tick-loop lifecycle. runUpdateTick itself is covered in
// src/update/background.test.ts — here we observe the extension boundary.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TickResult } from "../update/background.js"

const runUpdateTickMock = vi.fn<() => Promise<TickResult>>()
const getVersionMock = vi.fn(() => "0.0.22")
const isHomebrewInstallMock = vi.fn(() => false)
const loadAutoUpdateSettingMock = vi.fn(() => true)
const loadAutoUpdateNoticeShownMock = vi.fn(() => true)
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
vi.mock("../update/paths.js", () => ({
	isHomebrewInstall: () => isHomebrewInstallMock(),
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
	UPDATE_TICK_CHANNEL,
} = await import("./background-update.js")

type Handler = (event: unknown, ctx: unknown) => unknown

function createMockApi() {
	const handlers = new Map<string, Handler>()
	const events: Array<{ channel: string; payload: unknown }> = []
	const api = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler)
		},
		events: {
			emit: (channel: string, payload: unknown) => {
				events.push({ channel, payload })
			},
			on: () => {},
		},
	}
	return { handlers, events, api: api as unknown as Parameters<typeof backgroundUpdateExtension>[0] }
}

function makeCtx(hasUI = true) {
	const setStatus = vi.fn()
	return { ctx: { hasUI, ui: { setStatus } }, setStatus }
}

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
		["consent notice not yet shown", { noticeShown: false }],
	])("blocks when %s", (_reason, patch) => {
		expect(evaluateGates({ ...goodEnv(), ...patch })).not.toBeNull()
	})

	it("accepts a packaged binary on Windows paths", () => {
		expect(evaluateGates({ ...goodEnv(), platform: "win32", execPath: "C:\\Users\\a\\AppData\\kimchi.exe" })).toBeNull()
	})

	it("blocks a non-packaged binary on Windows paths", () => {
		expect(evaluateGates({ ...goodEnv(), platform: "win32", execPath: "C:\\Program Files\\nodejs\\node.exe" })).toBe(
			"non-packaged-binary",
		)
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
		vi.spyOn(process, "execPath", "get").mockReturnValue("/usr/local/bin/kimchi")
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	async function startSession(hasUI = true) {
		const { handlers, events, api } = createMockApi()
		backgroundUpdateExtension(api)
		const onStart = handlers.get("session_start")
		if (!onStart) throw new Error("no session_start handler")
		const { ctx, setStatus } = makeCtx(hasUI)
		await onStart({}, ctx)
		return { shutdown: handlers.get("session_shutdown"), setStatus, events }
	}

	it("runs the first tick ~10 seconds after session start", async () => {
		await startSession()
		expect(runUpdateTickMock).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(runUpdateTickMock).toHaveBeenCalledOnce()
	})

	it("does nothing when the session has no UI", async () => {
		await startSession(false)
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
		// check must tolerate the notice gate. At tick time it is marked.
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
		const { setStatus, events } = await startSession()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(setStatus).toHaveBeenCalledWith(UPDATE_INSTALLED_STATUS.key, UPDATE_INSTALLED_STATUS.text)
		expect(events).toContainEqual({
			channel: UPDATE_TICK_CHANNEL,
			payload: expect.objectContaining({ outcome: "installed", version: "v0.0.23" }),
		})
		// Session already installed this version; checking again would reinstall it.
		await vi.advanceTimersByTimeAsync(120 * 60_000)
		expect(runUpdateTickMock).toHaveBeenCalledOnce()
	})

	it("stays silent on failure but emits the telemetry event", async () => {
		runUpdateTickMock.mockResolvedValue({ outcome: "install-failed", version: "v0.0.23", error: "boom" })
		const { setStatus, events } = await startSession()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(setStatus).not.toHaveBeenCalled()
		expect(events).toContainEqual({
			channel: UPDATE_TICK_CHANNEL,
			payload: expect.objectContaining({ outcome: "install-failed" }),
		})
		// failures retry on schedule
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

	it("clears timers on session shutdown", async () => {
		const { shutdown } = await startSession()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(runUpdateTickMock).toHaveBeenCalledOnce()
		if (!shutdown) throw new Error("no session_shutdown handler")
		await shutdown({}, {})
		await vi.advanceTimersByTimeAsync(90 * 60_000)
		expect(runUpdateTickMock).toHaveBeenCalledOnce()
	})

	it("emits nothing and sets no status when the session shut down mid-tick", async () => {
		let resolveTick: ((r: TickResult) => void) | undefined
		runUpdateTickMock.mockReturnValue(new Promise((resolve) => (resolveTick = resolve)))
		const { shutdown, setStatus, events } = await startSession()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(runUpdateTickMock).toHaveBeenCalledOnce()
		if (!shutdown) throw new Error("no session_shutdown handler")
		await shutdown({}, {})
		// The in-flight tick settles after shutdown.
		resolveTick?.({ outcome: "installed", version: "v0.0.23" })
		await vi.advanceTimersByTimeAsync(0)
		expect(setStatus).not.toHaveBeenCalled()
		expect(events).toHaveLength(0)
	})
})
