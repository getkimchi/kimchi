import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// settings-watcher reads from process.env and fs — mock both.
vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	watch: vi.fn(),
}))

import { readFileSync, watch } from "node:fs"
import { getActiveThemeName, onThemeChange } from "./settings-watcher.js"

const mockReadFileSync = vi.mocked(readFileSync)
const mockWatch = vi.mocked(watch)

function createMockWatcher() {
	return { close: vi.fn(), on: vi.fn(), unref: vi.fn() }
}

function getWatchCallback(): (() => void) | undefined {
	return (mockWatch.mock.calls[0] as unknown[] | undefined)?.[2] as (() => void) | undefined
}

beforeEach(() => {
	process.env.KIMCHI_CODING_AGENT_DIR = "/fake/agent/dir"
	mockReadFileSync.mockReset()
	mockWatch.mockReset()
	mockWatch.mockReturnValue(createMockWatcher() as unknown as ReturnType<typeof watch>)
	vi.useFakeTimers()
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
	// biome-ignore lint/performance/noDelete: process.env requires delete operator to be truly unset rather than stringified to "undefined"
	delete process.env.KIMCHI_CODING_AGENT_DIR
})

describe("getActiveThemeName", () => {
	it("returns the theme from settings.json", () => {
		mockReadFileSync.mockReturnValue(JSON.stringify({ theme: "dark" }))
		expect(getActiveThemeName()).toBe("dark")
	})

	it("returns undefined when theme key is missing", () => {
		mockReadFileSync.mockReturnValue(JSON.stringify({ quietStartup: true }))
		expect(getActiveThemeName()).toBeUndefined()
	})

	it("returns undefined when file is unreadable", () => {
		mockReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT")
		})
		expect(getActiveThemeName()).toBeUndefined()
	})

	it("returns undefined when KIMCHI_CODING_AGENT_DIR is unset", () => {
		// biome-ignore lint/performance/noDelete: process.env requires delete operator to be truly unset rather than stringified to "undefined"
		delete process.env.KIMCHI_CODING_AGENT_DIR
		expect(getActiveThemeName()).toBeUndefined()
	})
})

describe("onThemeChange", () => {
	it("does not fire listener when theme has not changed", () => {
		mockReadFileSync.mockReturnValue(JSON.stringify({ theme: "kimchi-minimal" }))
		const listener = vi.fn()

		// Subscribe — watcher captures lastSeenTheme = "kimchi-minimal"
		const unsub = onThemeChange(listener)

		// Trigger the fs.watch callback (same theme in file)
		getWatchCallback()?.()
		vi.runAllTimers() // flush debounce

		expect(listener).not.toHaveBeenCalled()
		unsub()
	})

	it("fires listener when theme changes", () => {
		mockReadFileSync
			.mockReturnValueOnce(JSON.stringify({ theme: "kimchi-minimal" })) // ensureWatcher init read
			.mockReturnValue(JSON.stringify({ theme: "dark" })) // subsequent read after change

		const listener = vi.fn()
		const unsub = onThemeChange(listener)

		getWatchCallback()?.()
		vi.runAllTimers()

		expect(listener).toHaveBeenCalledWith("dark", "kimchi-minimal")
		unsub()
	})

	it("closes the watcher when last listener unsubscribes", () => {
		mockReadFileSync.mockReturnValue(JSON.stringify({ theme: "dark" }))
		const mockWatcherInstance = createMockWatcher()
		mockWatch.mockReturnValue(mockWatcherInstance as unknown as ReturnType<typeof watch>)

		const unsub = onThemeChange(vi.fn())
		unsub()

		expect(mockWatcherInstance.close).toHaveBeenCalled()
	})

	it("does not keep the process alive by default", () => {
		mockReadFileSync.mockReturnValue(JSON.stringify({ theme: "dark" }))
		const mockWatcherInstance = createMockWatcher()
		mockWatch.mockReturnValue(mockWatcherInstance as unknown as ReturnType<typeof watch>)

		const unsub = onThemeChange(vi.fn())
		unsub()

		expect(mockWatch).toHaveBeenCalledWith("/fake/agent/dir/settings.json", { persistent: false }, expect.any(Function))
		expect(mockWatcherInstance.unref).toHaveBeenCalled()
	})
})
