import { describe, expect, it, vi } from "vitest"
import { forwardAbortSignal } from "./abort-signal.js"

describe("forwardAbortSignal", () => {
	it("hard-aborts a child whose signal was already aborted during setup", () => {
		const controller = new AbortController()
		const session = { abort: vi.fn(async () => {}), abortBash: vi.fn() }
		controller.abort()
		const listener = vi.spyOn(controller.signal, "addEventListener")
		forwardAbortSignal(session, controller.signal)
		expect(session.abortBash).toHaveBeenCalledOnce()
		expect(session.abort).toHaveBeenCalledOnce()
		expect(listener).not.toHaveBeenCalled()
	})

	it("stops forwarding when the owning run cleans up", () => {
		const controller = new AbortController()
		const session = { abort: vi.fn(async () => {}), abortBash: vi.fn() }
		const cleanup = forwardAbortSignal(session, controller.signal)
		cleanup()
		controller.abort()
		expect(session.abort).not.toHaveBeenCalled()
		expect(session.abortBash).not.toHaveBeenCalled()
	})
})
