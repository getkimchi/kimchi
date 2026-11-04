// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// We test the browser pool by mocking the playwright import.
// Use dynamic import reset to control what import("playwright") returns.

let mockBrowser: {
	isConnected: () => boolean
	close: ReturnType<typeof vi.fn>
	on: ReturnType<typeof vi.fn>
}

let launchMock: ReturnType<typeof vi.fn>
let playwrightImportFails: boolean

vi.mock("playwright", () => {
	return {
		get chromium() {
			if (playwrightImportFails) {
				throw new Error("Cannot find module 'playwright'")
			}
			return { launch: (...args: unknown[]) => launchMock(...args) }
		},
	}
})

import { BrowserPool } from "./browser-pool.js"

describe("BrowserPool", () => {
	let pool: BrowserPool

	beforeEach(() => {
		playwrightImportFails = false

		let connected = true
		mockBrowser = {
			isConnected: () => connected,
			close: vi.fn().mockImplementation(async () => {
				connected = false
			}),
			on: vi.fn(),
		}

		launchMock = vi.fn().mockResolvedValue(mockBrowser)
		pool = new BrowserPool()
	})

	afterEach(async () => {
		await pool.shutdown()
		vi.restoreAllMocks()
	})

	it("returns a browser on first call (lazy init)", async () => {
		const browser = await pool.getBrowser()
		expect(browser).toBe(mockBrowser)
		expect(launchMock).toHaveBeenCalledOnce()
		expect(launchMock).toHaveBeenCalledWith({ headless: true })
	})

	it("reuses the browser on subsequent calls", async () => {
		const first = await pool.getBrowser()
		const second = await pool.getBrowser()
		expect(first).toBe(second)
		expect(launchMock).toHaveBeenCalledOnce()
	})

	it("returns null when playwright is not installed", async () => {
		playwrightImportFails = true
		pool = new BrowserPool()
		const browser = await pool.getBrowser()
		expect(browser).toBeNull()
		expect(pool.isPlaywrightAvailable()).toBe(false)
	})

	it("returns null on subsequent calls after playwright was detected as missing", async () => {
		playwrightImportFails = true
		pool = new BrowserPool()
		await pool.getBrowser()
		// Even if we "fix" it, the cached flag stays false within the session
		playwrightImportFails = false
		const browser = await pool.getBrowser()
		expect(browser).toBeNull()
	})

	it("returns null when chromium executable is missing and permanently disables", async () => {
		launchMock.mockRejectedValue(new Error("browserType.launch: Executable doesn't exist at /path/to/chromium"))
		const browser = await pool.getBrowser()
		expect(browser).toBeNull()
		expect(pool.isPlaywrightAvailable()).toBe(false)

		// Subsequent call should not retry
		launchMock.mockResolvedValue(mockBrowser)
		const second = await pool.getBrowser()
		expect(second).toBeNull()
		expect(launchMock).toHaveBeenCalledOnce()
	})

	it("retries after transient launch error (e.g. ENOMEM)", async () => {
		launchMock.mockRejectedValueOnce(new Error("spawn ENOMEM"))
		const first = await pool.getBrowser()
		expect(first).toBeNull()
		// playwrightAvailable should still be true so next call retries
		expect(pool.isPlaywrightAvailable()).toBe(true)

		// Next call succeeds
		launchMock.mockResolvedValue(mockBrowser)
		const second = await pool.getBrowser()
		expect(second).toBe(mockBrowser)
		expect(launchMock).toHaveBeenCalledTimes(2)
	})

	it("creates a new browser after the old one disconnects", async () => {
		const first = await pool.getBrowser()
		expect(first).toBe(mockBrowser)

		// Simulate disconnect: fire the "disconnected" handler
		const disconnectHandler = mockBrowser.on.mock.calls.find(
			(call: unknown[]) => call[0] === "disconnected",
		)?.[1] as () => void
		expect(disconnectHandler).toBeDefined()
		disconnectHandler()

		// Create a new mock browser for the re-launch
		const newBrowser = {
			isConnected: () => true,
			close: vi.fn(),
			on: vi.fn(),
		}
		launchMock.mockResolvedValue(newBrowser)

		const second = await pool.getBrowser()
		expect(second).toBe(newBrowser)
		expect(launchMock).toHaveBeenCalledTimes(2)
	})

	it("shutdown closes the browser", async () => {
		await pool.getBrowser()
		await pool.shutdown()
		expect(mockBrowser.close).toHaveBeenCalled()
	})

	it("shutdown is safe to call with no browser", async () => {
		// Should not throw
		await pool.shutdown()
	})

	it("registers disconnected event handler", async () => {
		await pool.getBrowser()
		expect(mockBrowser.on).toHaveBeenCalledWith("disconnected", expect.any(Function))
	})

	describe("idle timeout", () => {
		beforeEach(() => {
			vi.useFakeTimers()
			pool = new BrowserPool({ idleTimeoutMs: 500 })
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("closes browser after idle timeout expires", async () => {
			await pool.getBrowser()
			expect(mockBrowser.close).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(500)

			expect(mockBrowser.close).toHaveBeenCalledOnce()
		})

		it("resets idle timer on subsequent getBrowser calls", async () => {
			await pool.getBrowser()

			// Advance partway — browser should still be alive
			await vi.advanceTimersByTimeAsync(400)
			expect(mockBrowser.close).not.toHaveBeenCalled()

			// Second call resets the timer
			await pool.getBrowser()

			// Advance another 400ms (800ms total, but only 400ms since reset)
			await vi.advanceTimersByTimeAsync(400)
			expect(mockBrowser.close).not.toHaveBeenCalled()

			// Advance past the reset timer
			await vi.advanceTimersByTimeAsync(100)
			expect(mockBrowser.close).toHaveBeenCalledOnce()
		})

		it("creates a new browser after idle timeout closed the previous one", async () => {
			const first = await pool.getBrowser()
			expect(first).toBe(mockBrowser)

			// Let idle timeout fire
			await vi.advanceTimersByTimeAsync(500)
			expect(mockBrowser.close).toHaveBeenCalledOnce()

			// New browser for next call
			const newBrowser = {
				isConnected: () => true,
				close: vi.fn(),
				on: vi.fn(),
			}
			launchMock.mockResolvedValue(newBrowser)

			const second = await pool.getBrowser()
			expect(second).toBe(newBrowser)
			expect(launchMock).toHaveBeenCalledTimes(2)
		})
	})

	describe("crash recovery", () => {
		it("recovers after browser disconnect and serves subsequent fetch", async () => {
			const first = await pool.getBrowser()
			expect(first).toBe(mockBrowser)

			// Simulate crash via disconnected event
			const disconnectHandler = mockBrowser.on.mock.calls.find(
				(call: unknown[]) => call[0] === "disconnected",
			)?.[1] as () => void
			disconnectHandler()

			// Prepare a fresh browser for recovery
			const recoveredBrowser = {
				isConnected: () => true,
				close: vi.fn(),
				on: vi.fn(),
			}
			launchMock.mockResolvedValue(recoveredBrowser)

			// Next call should lazily create a new browser
			const second = await pool.getBrowser()
			expect(second).toBe(recoveredBrowser)
			expect(second).not.toBe(first)
			expect(launchMock).toHaveBeenCalledTimes(2)
		})
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
