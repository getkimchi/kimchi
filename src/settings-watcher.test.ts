import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// settings-watcher watches settings.json via fs.watch and reads settings through
// pi's SettingsManager — mock both so tests don't depend on real files (and so the
// node:fs mock doesn't leak into pi internals).
vi.mock("node:fs", () => ({
	watch: vi.fn(),
}))

vi.mock("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: vi.fn(() => "/fake/agent/dir"),
	SettingsManager: { create: vi.fn() },
}))

import { watch } from "node:fs"
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent"
import {
	__resetSettingsWatcherForTest,
	getActiveThemeName,
	getCompactionEnabled,
	getSettingsManager,
	onThemeChange,
	setSettingsProjectTrusted,
} from "./settings-watcher.js"

const mockWatch = vi.mocked(watch)
const mockCreate = vi.mocked(SettingsManager.create)
const mockAgentDir = vi.mocked(getAgentDir)

function createMockWatcher() {
	return { close: vi.fn(), on: vi.fn(), unref: vi.fn() }
}

/** A stand-in SettingsManager exposing pi's theme + compaction + trust accessors. */
function fakeManager(opts: { theme?: string; compactionEnabled?: boolean } = {}) {
	let trusted = false
	return {
		getThemeSetting: vi.fn(() => opts.theme),
		getCompactionEnabled: vi.fn(() => opts.compactionEnabled ?? true),
		isProjectTrusted: vi.fn(() => trusted),
		setProjectTrusted: vi.fn((t: boolean) => {
			trusted = t
		}),
	}
}

function asManager(m: ReturnType<typeof fakeManager>): SettingsManager {
	return m as unknown as SettingsManager
}

/** The scheduleFire callback of the n-th fs.watch call (0 = global, 1 = project). */
function getWatchCallback(index = 0): (() => void) | undefined {
	return (mockWatch.mock.calls[index] as unknown[] | undefined)?.[2] as (() => void) | undefined
}

beforeEach(() => {
	__resetSettingsWatcherForTest()
	mockWatch.mockReset()
	mockWatch.mockReturnValue(createMockWatcher() as unknown as ReturnType<typeof watch>)
	mockCreate.mockReset()
	mockCreate.mockReturnValue(asManager(fakeManager()))
	mockAgentDir.mockReset()
	mockAgentDir.mockReturnValue("/fake/agent/dir")
	vi.useFakeTimers()
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe("getActiveThemeName", () => {
	it("returns the theme from pi settings", () => {
		mockCreate.mockReturnValue(asManager(fakeManager({ theme: "dark" })))
		expect(getActiveThemeName()).toBe("dark")
	})

	it("returns undefined when no theme is set", () => {
		mockCreate.mockReturnValue(asManager(fakeManager({})))
		expect(getActiveThemeName()).toBeUndefined()
	})

	it("returns undefined when the SettingsManager cannot be constructed", () => {
		mockCreate.mockImplementation(() => {
			throw new Error("boom")
		})
		expect(getActiveThemeName()).toBeUndefined()
	})
})

describe("getCompactionEnabled", () => {
	it("returns true when compaction is enabled", () => {
		mockCreate.mockReturnValue(asManager(fakeManager({ compactionEnabled: true })))
		expect(getCompactionEnabled()).toBe(true)
	})

	it("returns false when compaction is disabled", () => {
		mockCreate.mockReturnValue(asManager(fakeManager({ compactionEnabled: false })))
		expect(getCompactionEnabled()).toBe(false)
	})

	it("returns true when the SettingsManager cannot be constructed", () => {
		mockCreate.mockImplementation(() => {
			throw new Error("boom")
		})
		expect(getCompactionEnabled()).toBe(true)
	})

	it("returns true when reading settings throws", () => {
		mockCreate.mockReturnValue({
			isProjectTrusted: () => false,
			getCompactionEnabled: () => {
				throw new Error("boom")
			},
		} as unknown as SettingsManager)
		expect(getCompactionEnabled()).toBe(true)
	})

	it("caches the manager and rebuilds it after the global settings file changes", () => {
		mockCreate.mockReturnValue(asManager(fakeManager({ compactionEnabled: false })))
		expect(getCompactionEnabled()).toBe(false)
		expect(mockCreate).toHaveBeenCalledTimes(1)

		// Second call reuses the cached manager (no rebuild).
		getCompactionEnabled()
		expect(mockCreate).toHaveBeenCalledTimes(1)

		// Global settings.json changes → watcher fires → manager dropped & rebuilt.
		mockCreate.mockReturnValue(asManager(fakeManager({ compactionEnabled: true })))
		getWatchCallback(0)?.()
		vi.runAllTimers()

		expect(getCompactionEnabled()).toBe(true)
		expect(mockCreate).toHaveBeenCalledTimes(2)
	})

	it("rebuilds the manager after the PROJECT settings file changes", () => {
		mockCreate.mockReturnValue(asManager(fakeManager({ compactionEnabled: true })))
		expect(getCompactionEnabled()).toBe(true)
		expect(mockCreate).toHaveBeenCalledTimes(1)

		// Project .pi/settings.json changes → project watcher fires → rebuild.
		mockCreate.mockReturnValue(asManager(fakeManager({ compactionEnabled: false })))
		getWatchCallback(1)?.()
		vi.runAllTimers()

		expect(getCompactionEnabled()).toBe(false)
		expect(mockCreate).toHaveBeenCalledTimes(2)
	})
})

describe("project trust", () => {
	it("constructs untrusted by default (project settings ignored until trust is known)", () => {
		getSettingsManager()
		expect(mockCreate).toHaveBeenCalledWith(expect.any(String), "/fake/agent/dir", { projectTrusted: false })
	})

	it("syncs a caller-reported trust decision onto the live manager", () => {
		const sm = fakeManager({ compactionEnabled: true })
		mockCreate.mockReturnValue(asManager(sm))

		getCompactionEnabled() // constructs untrusted
		getCompactionEnabled(true) // syncs trust onto the live instance

		expect(sm.setProjectTrusted).toHaveBeenCalledWith(true)
		// The live instance was updated in place — no rebuild required.
		expect(mockCreate).toHaveBeenCalledTimes(1)
	})

	it("constructs later rebuilds with the last-synced trust", () => {
		setSettingsProjectTrusted(true)
		getSettingsManager()
		expect(mockCreate).toHaveBeenLastCalledWith(expect.any(String), "/fake/agent/dir", { projectTrusted: true })
	})

	it("does not touch trust when the caller cannot report it", () => {
		const sm = fakeManager()
		mockCreate.mockReturnValue(asManager(sm))

		getCompactionEnabled(undefined)

		expect(sm.setProjectTrusted).not.toHaveBeenCalled()
	})
})

describe("getSettingsManager", () => {
	it("constructs a manager over the pi-resolved agent dir (getAgentDir)", () => {
		mockAgentDir.mockReturnValue("/resolved/agent/dir")
		getSettingsManager()
		expect(mockAgentDir).toHaveBeenCalled()
		expect(mockCreate).toHaveBeenCalledWith(expect.any(String), "/resolved/agent/dir", { projectTrusted: false })
	})

	it("watches both the global and project settings files", () => {
		getSettingsManager()
		const paths = mockWatch.mock.calls.map((c) => c[0])
		expect(paths).toContain("/fake/agent/dir/settings.json")
		expect(paths.some((p) => typeof p === "string" && p.endsWith("/.pi/settings.json"))).toBe(true)
	})

	it("re-arms a watcher that failed to start on the next read", () => {
		// Global settings.json doesn't exist yet — its watch throws until it appears.
		const globalPath = "/fake/agent/dir/settings.json"
		let globalFileMissing = true
		mockWatch.mockImplementation(((path: unknown) => {
			if (globalFileMissing && path === globalPath) throw new Error("ENOENT")
			return createMockWatcher() as unknown as ReturnType<typeof watch>
		}) as unknown as typeof watch)

		getSettingsManager()
		const attemptsWhileMissing = mockWatch.mock.calls.filter((c) => c[0] === globalPath).length
		expect(attemptsWhileMissing).toBeGreaterThan(0)

		// The file appears — the next read re-arms the global watch.
		globalFileMissing = false
		getSettingsManager()
		const attempts = mockWatch.mock.calls.filter((c) => c[0] === globalPath).length
		expect(attempts).toBeGreaterThan(attemptsWhileMissing)
	})

	it("recreates a watcher and drops the cache after a watch error", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
		const watcher = createMockWatcher()
		mockWatch.mockReturnValue(watcher as unknown as ReturnType<typeof watch>)

		getSettingsManager()
		expect(mockWatch).toHaveBeenCalledTimes(2) // global + project
		expect(mockCreate).toHaveBeenCalledTimes(1)

		// Fire the global watcher's error handler (registered via watcher.on).
		const errorHandler = watcher.on.mock.calls.find((c) => c[0] === "error")?.[1] as (err: Error) => void
		errorHandler(new Error("EPERM"))

		// Next read rebuilds the manager (cache dropped) and re-arms the dead watcher.
		getSettingsManager()
		expect(mockCreate).toHaveBeenCalledTimes(2)
		expect(mockWatch).toHaveBeenCalledTimes(3)
	})

	it("drops the watcher and cache even when close() throws during error handling", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
		const watcher = createMockWatcher()
		watcher.close.mockImplementation(() => {
			throw new Error("already destroyed")
		})
		mockWatch.mockReturnValue(watcher as unknown as ReturnType<typeof watch>)

		getSettingsManager()
		expect(mockCreate).toHaveBeenCalledTimes(1)

		const errorHandler = watcher.on.mock.calls.find((c) => c[0] === "error")?.[1] as (err: Error) => void
		expect(() => errorHandler(new Error("EPERM"))).not.toThrow()

		// Cache was dropped despite close() throwing — the next read rebuilds.
		getSettingsManager()
		expect(mockCreate).toHaveBeenCalledTimes(2)
	})

	it("delivers a theme change that happened while a watcher was dead", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
		const watcher = createMockWatcher()
		mockWatch.mockReturnValue(watcher as unknown as ReturnType<typeof watch>)
		mockCreate.mockReturnValue(asManager(fakeManager({ theme: "light" })))
		const listener = vi.fn()
		onThemeChange(listener) // seeds lastSeenTheme = "light"

		// The global watcher dies; the theme changes while nothing is watching.
		const errorHandler = watcher.on.mock.calls.find((c) => c[0] === "error")?.[1] as (err: Error) => void
		errorHandler(new Error("EPERM"))
		mockCreate.mockReturnValue(asManager(fakeManager({ theme: "dark" })))

		// The next read re-arms the watcher and schedules a catch-up fire.
		getSettingsManager()
		vi.runAllTimers()

		expect(listener).toHaveBeenCalledWith("dark", "light")
	})

	it("catches up on changes that happened while a settings file was unwatched", () => {
		// Global settings.json doesn't exist yet — its watch throws until it appears.
		const globalPath = "/fake/agent/dir/settings.json"
		let globalFileMissing = true
		mockWatch.mockImplementation(((path: unknown) => {
			if (globalFileMissing && path === globalPath) throw new Error("ENOENT")
			return createMockWatcher() as unknown as ReturnType<typeof watch>
		}) as unknown as typeof watch)
		mockCreate.mockReturnValue(asManager(fakeManager({ theme: "light" })))
		const listener = vi.fn()
		onThemeChange(listener) // seeds "light"; the global watch fails to arm

		// The file appears with a different theme; the next read arms the watch
		// and the catch-up fire delivers the change that predates it.
		mockCreate.mockReturnValue(asManager(fakeManager({ theme: "dark" })))
		globalFileMissing = false
		getSettingsManager()
		vi.runAllTimers()

		expect(listener).toHaveBeenCalledWith("dark", "light")
	})
})

describe("onThemeChange", () => {
	it("does not fire listener when theme has not changed", () => {
		mockCreate.mockReturnValue(asManager(fakeManager({ theme: "kimchi-minimal" })))
		const listener = vi.fn()

		// Subscribe — ensureWatchers seeds lastSeenTheme = "kimchi-minimal"
		const unsub = onThemeChange(listener)

		getWatchCallback(0)?.()
		vi.runAllTimers() // flush debounce

		expect(listener).not.toHaveBeenCalled()
		unsub()
	})

	it("fires listener when theme changes", () => {
		mockCreate.mockReturnValue(asManager(fakeManager({ theme: "kimchi-minimal" })))
		const listener = vi.fn()
		const unsub = onThemeChange(listener)

		// settings change → the rebuilt manager reports a different theme
		mockCreate.mockReturnValue(asManager(fakeManager({ theme: "dark" })))
		getWatchCallback(0)?.()
		vi.runAllTimers()

		expect(listener).toHaveBeenCalledWith("dark", "kimchi-minimal")
		unsub()
	})

	it("does not keep the process alive by default", () => {
		const mockWatcherInstance = createMockWatcher()
		mockWatch.mockReturnValue(mockWatcherInstance as unknown as ReturnType<typeof watch>)

		onThemeChange(vi.fn())

		expect(mockWatch).toHaveBeenCalledWith("/fake/agent/dir/settings.json", { persistent: false }, expect.any(Function))
		expect(mockWatcherInstance.unref).toHaveBeenCalled()
	})

	it("closes both the global and project watchers on reset", () => {
		const mockWatcherInstance = createMockWatcher()
		mockWatch.mockReturnValue(mockWatcherInstance as unknown as ReturnType<typeof watch>)

		onThemeChange(vi.fn())
		__resetSettingsWatcherForTest()

		expect(mockWatcherInstance.close).toHaveBeenCalledTimes(2)
	})
})
