import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// settings-watcher watches settings.json via fs.watch and reads settings through
// pi's SettingsManager — mock both so tests don't depend on real files (and so the
// node:fs mock doesn't leak into pi internals).
//
// statSync is mocked so tests can drive the mtime/size signature gate that
// suppresses spurious fs.watch events. By default it reports a stable signature
// (no change); tests that simulate a real file change bump `statSeq`.
const statMock = vi.fn()
vi.mock("node:fs", () => ({
	watch: vi.fn(),
	statSync: (path: string) => statMock(path),
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
	// Default: every stat returns the same signature (no change). Tests that
	// simulate a real file write call `bumpFileSignature()` to advance the
	// mtime so `fire()` rebuilds the manager.
	statMock.mockReset()
	statMock.mockImplementation(() => ({ mtimeMs: 0, size: 0 }))
	vi.useFakeTimers()
})

/** Simulate a real settings file write: advance the stat signature so the next
 *  `fire()` sees a changed file and rebuilds the cached SettingsManager.
 *  Only bumps the global settings path by default; pass `"project"` to bump
 *  the project path instead, so tests properly isolate which file changed. */
function bumpFileSignature(which: "global" | "project" = "global"): void {
	const globalPath = "/fake/agent/dir/settings.json"
	const projectPath = resolve(process.cwd(), ".pi", "settings.json")
	const target = which === "project" ? projectPath : globalPath
	const mtimeByPath = new Map<string, number>()
	// Seed current mtime per path from existing mock results, defaulting to 0.
	statMock.mockImplementation((p: string) => {
		const m = mtimeByPath.get(p) ?? 0
		return { mtimeMs: m, size: 0 }
	})
	// Bump only the target path.
	mtimeByPath.set(target, 1)
}

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
		bumpFileSignature()
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
		bumpFileSignature()
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

	it("syncs a trust decision onto the live manager in place", () => {
		const sm = fakeManager({ compactionEnabled: true })
		mockCreate.mockReturnValue(asManager(sm))

		getCompactionEnabled() // constructs untrusted
		setSettingsProjectTrusted(true) // the session_start sync

		expect(sm.setProjectTrusted).toHaveBeenCalledWith(true)
		// The live instance was updated in place — no rebuild required.
		expect(mockCreate).toHaveBeenCalledTimes(1)
	})

	it("constructs later rebuilds with the last-synced trust", () => {
		setSettingsProjectTrusted(true)
		getSettingsManager()
		expect(mockCreate).toHaveBeenLastCalledWith(expect.any(String), "/fake/agent/dir", { projectTrusted: true })
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
		// The file changed while the watcher was dead — advance the stat signature
		// so the catch-up fire rebuilds and detects the new theme.
		bumpFileSignature()
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
		bumpFileSignature()
		mockCreate.mockReturnValue(asManager(fakeManager({ theme: "dark" })))
		globalFileMissing = false
		getSettingsManager()
		vi.runAllTimers()

		expect(listener).toHaveBeenCalledWith("dark", "light")
	})

	it("does not rebuild the manager on spurious fs.watch events when the file is unchanged", () => {
		// Regression: macOS/bun `fs.watch` emits ~20 spurious change events per
		// second on an unchanged settings.json. Each used to rebuild the
		// SettingsManager (lockfile + readFileSync) — 20-30% CPU at idle. The
		// mtime/size signature gate must suppress the rebuild when the file's
		// stat signature is identical, even across many events.
		mockCreate.mockReturnValue(asManager(fakeManager({ theme: "dark" })))
		const listener = vi.fn()
		onThemeChange(listener) // seeds lastSeenTheme = "dark" and arms watches
		expect(mockCreate).toHaveBeenCalledTimes(1)

		// Spurious event storm: the global watcher fires 50 times but the file's
		// mtime/size never changes. fire() must early-return each time.
		const globalCb = getWatchCallback(0)
		for (let i = 0; i < 50; i++) globalCb?.()
		vi.runAllTimers()

		// No rebuild happened — the cached manager is untouched.
		expect(mockCreate).toHaveBeenCalledTimes(1)
		// And no theme-change notification fired.
		expect(listener).not.toHaveBeenCalled()
	})

	it("catch-up fire detects changes even when the project file never existed", () => {
		// The reviewer found a regression: recordSignature was called on re-arm
		// after a broken watcher, overwriting the old signature so the catch-up
		// fire() could not detect changes. This test isolates that scenario:
		// only the global file changes; the project file was never watchable.
		const globalPath = "/fake/agent/dir/settings.json"
		let globalFileMissing = true
		mockWatch.mockImplementation(((path: unknown) => {
			if (globalFileMissing && path === globalPath) throw new Error("ENOENT")
			return createMockWatcher() as unknown as ReturnType<typeof watch>
		}) as unknown as typeof watch)
		mockCreate.mockReturnValue(asManager(fakeManager({ theme: "light" })))
		const listener = vi.fn()
		onThemeChange(listener) // seeds "light"; global watch fails to arm

		// The global file appears with a different theme AND a different mtime.
		// Only bump the global path — the project path stays at its original
		// signature (or undefined if it never armed).
		bumpFileSignature("global")
		mockCreate.mockReturnValue(asManager(fakeManager({ theme: "dark" })))
		globalFileMissing = false
		getSettingsManager()
		vi.runAllTimers()

		// The catch-up fire must detect the change and notify.
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
		bumpFileSignature()
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
