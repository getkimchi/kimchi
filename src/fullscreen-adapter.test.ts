import { afterEach, describe, expect, it, vi } from "vitest"
import { routeFullscreenWarnings } from "./fullscreen-adapter.js"

afterEach(() => vi.restoreAllMocks())

describe("fullscreen console warnings", () => {
	it("renders warnings as notifications only while the terminal is running", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const notify = vi.fn()
		const tui = { start: vi.fn(), stop: vi.fn() }
		routeFullscreenWarnings(tui, notify)
		console.warn("before")
		expect(warn).toHaveBeenCalledWith("before")
		tui.start()
		try {
			tui.start()
			console.warn("warning %s", "details")
			console.error("failure")
			expect(notify.mock.calls).toEqual([
				["warning details", "warning"],
				["failure", "error"],
			])
			expect(warn).toHaveBeenCalledTimes(1)
			expect(error).not.toHaveBeenCalled()
		} finally {
			tui.stop()
		}
		expect(console.warn).toBe(warn)
		expect(console.error).toBe(error)
		tui.start()
		try {
			console.warn("restarted")
			expect(notify).toHaveBeenLastCalledWith("restarted", "warning")
		} finally {
			tui.stop()
		}
		expect(console.warn).toBe(warn)
	})
})
