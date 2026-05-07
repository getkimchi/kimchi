import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MAX_TIMEOUT_MS, timeoutGuardExtension } from "./timeout-guard.js"

type StubHandler = (evt: unknown, ctx: unknown) => unknown

function makeStubPi() {
	const handlers: Record<string, StubHandler[]> = {}
	return {
		on: vi.fn((event: string, handler: StubHandler) => {
			if (handlers[event] === undefined) handlers[event] = []
			handlers[event].push(handler)
		}),
		fireSessionStart: (ctx: unknown = {}) => {
			for (const h of handlers.session_start ?? []) h({ type: "session_start" }, ctx)
		},
		fireSessionShutdown: () => {
			for (const h of handlers.session_shutdown ?? []) h({ type: "session_shutdown" }, {})
		},
	}
}

describe("timeoutGuardExtension", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("registers session_start and session_shutdown handlers (exactly those, no others)", () => {
		const pi = makeStubPi()
		const onTimeout = vi.fn()
		timeoutGuardExtension({ timeoutMs: 1000, onTimeout })(pi as unknown as ExtensionAPI)

		const registeredEvents = pi.on.mock.calls.map((c) => c[0])
		expect(registeredEvents).toContain("session_start")
		expect(registeredEvents).toContain("session_shutdown")
		expect(registeredEvents).toHaveLength(2)
	})

	it("throws synchronously when constructed with timeoutMs: 0", () => {
		expect(() => timeoutGuardExtension({ timeoutMs: 0, onTimeout: vi.fn() })).toThrow(/timeoutMs/)
	})

	it("throws synchronously when timeoutMs: -1", () => {
		expect(() => timeoutGuardExtension({ timeoutMs: -1, onTimeout: vi.fn() })).toThrow(/timeoutMs/)
	})

	it("calls onTimeout after timeoutMs ms have advanced past session_start", () => {
		const pi = makeStubPi()
		const onTimeout = vi.fn()
		timeoutGuardExtension({ timeoutMs: 5000, onTimeout })(pi as unknown as ExtensionAPI)

		pi.fireSessionStart()
		vi.advanceTimersByTime(4999)
		expect(onTimeout).not.toHaveBeenCalled()

		vi.advanceTimersByTime(1)
		expect(onTimeout).toHaveBeenCalledTimes(1)
	})

	it("does NOT call onTimeout if session_shutdown fires before the timer expires", () => {
		const pi = makeStubPi()
		const onTimeout = vi.fn()
		timeoutGuardExtension({ timeoutMs: 5000, onTimeout })(pi as unknown as ExtensionAPI)

		pi.fireSessionStart()
		vi.advanceTimersByTime(3000)
		pi.fireSessionShutdown()
		vi.advanceTimersByTime(5000)

		expect(onTimeout).not.toHaveBeenCalled()
	})

	it("does NOT call onTimeout if no session_start ever fires (timer not armed)", () => {
		const pi = makeStubPi()
		const onTimeout = vi.fn()
		timeoutGuardExtension({ timeoutMs: 5000, onTimeout })(pi as unknown as ExtensionAPI)

		vi.advanceTimersByTime(10000)

		expect(onTimeout).not.toHaveBeenCalled()
	})

	it("clamps timeoutMs > MAX_TIMEOUT_MS to MAX_TIMEOUT_MS", () => {
		const pi = makeStubPi()
		const onTimeout = vi.fn()
		timeoutGuardExtension({ timeoutMs: MAX_TIMEOUT_MS + 1, onTimeout })(pi as unknown as ExtensionAPI)

		pi.fireSessionStart()
		vi.advanceTimersByTime(MAX_TIMEOUT_MS - 1)
		expect(onTimeout).not.toHaveBeenCalled()

		vi.advanceTimersByTime(1)
		expect(onTimeout).toHaveBeenCalledTimes(1)
	})

	it("calls ctx.shutdown() before onTimeout when the timer fires", () => {
		const pi = makeStubPi()
		const onTimeout = vi.fn()
		const shutdown = vi.fn()
		const callOrder: string[] = []
		shutdown.mockImplementation(() => callOrder.push("shutdown"))
		onTimeout.mockImplementation(() => callOrder.push("onTimeout"))

		timeoutGuardExtension({ timeoutMs: 5000, onTimeout })(pi as unknown as ExtensionAPI)
		pi.fireSessionStart({ shutdown })

		vi.advanceTimersByTime(5000)

		expect(shutdown).toHaveBeenCalledTimes(1)
		expect(onTimeout).toHaveBeenCalledTimes(1)
		expect(callOrder).toEqual(["shutdown", "onTimeout"])
	})

	it("does not throw when ctx.shutdown() throws synchronously", () => {
		const pi = makeStubPi()
		const onTimeout = vi.fn()
		const shutdown = vi.fn(() => {
			throw new Error("teardown failed")
		})

		timeoutGuardExtension({ timeoutMs: 5000, onTimeout })(pi as unknown as ExtensionAPI)
		pi.fireSessionStart({ shutdown })

		expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
		expect(onTimeout).toHaveBeenCalledTimes(1)
	})

	it("multiple session_start events: only one timer is armed at a time", () => {
		const pi = makeStubPi()
		const onTimeout = vi.fn()
		timeoutGuardExtension({ timeoutMs: 5000, onTimeout })(pi as unknown as ExtensionAPI)

		// First session_start arms the timer
		pi.fireSessionStart()
		vi.advanceTimersByTime(3000)

		// Second session_start re-arms; the prior timer should be cleared
		pi.fireSessionStart()
		vi.advanceTimersByTime(4999)
		expect(onTimeout).not.toHaveBeenCalled()

		vi.advanceTimersByTime(1)
		expect(onTimeout).toHaveBeenCalledTimes(1)
	})
})
