import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { notifyUser } from "./notify-user.js"

function createContext(hasUI: boolean) {
	const notify = vi.fn()
	return {
		ctx: { hasUI, ui: { notify } } as unknown as Pick<ExtensionContext, "hasUI" | "ui">,
		notify,
	}
}

describe("notifyUser", () => {
	let errorSpy: ReturnType<typeof vi.spyOn>
	let warnSpy: ReturnType<typeof vi.spyOn>
	let logSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("delegates to ui.notify with the message and severity when a UI is attached", () => {
		for (const severity of ["info", "warning", "error"] as const) {
			const { ctx, notify } = createContext(true)
			notifyUser(ctx, `message for ${severity}`, severity)
			expect(notify).toHaveBeenCalledWith(`message for ${severity}`, severity)
		}
	})

	it("produces no console output when a UI is attached", () => {
		const { ctx } = createContext(true)
		notifyUser(ctx, "silent in TUI", "warning")
		expect(errorSpy).not.toHaveBeenCalled()
		expect(warnSpy).not.toHaveBeenCalled()
		expect(logSpy).not.toHaveBeenCalled()
	})

	it("maps error severity to console.error in headless mode", () => {
		const { ctx } = createContext(false)
		notifyUser(ctx, "boom", "error")
		expect(errorSpy).toHaveBeenCalledWith("boom")
		expect(warnSpy).not.toHaveBeenCalled()
		expect(logSpy).not.toHaveBeenCalled()
	})

	it("maps warning severity to console.warn in headless mode", () => {
		const { ctx } = createContext(false)
		notifyUser(ctx, "careful", "warning")
		expect(warnSpy).toHaveBeenCalledWith("careful")
		expect(errorSpy).not.toHaveBeenCalled()
		expect(logSpy).not.toHaveBeenCalled()
	})

	it("maps info severity to console.log in headless mode", () => {
		const { ctx } = createContext(false)
		notifyUser(ctx, "fyi", "info")
		expect(logSpy).toHaveBeenCalledWith("fyi")
		expect(errorSpy).not.toHaveBeenCalled()
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it("passes interpolated messages through unchanged", () => {
		const { ctx, notify } = createContext(true)
		const message = `permissions: failed (details: ${"nested"})`
		notifyUser(ctx, message, "warning")
		expect(notify).toHaveBeenCalledWith(message, "warning")
	})
})
