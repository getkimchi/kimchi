import type { ExtensionAPI, InputEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Handler = (...args: unknown[]) => Promise<unknown> | unknown

function createMockApi() {
	const handlers = new Map<string, Handler[]>()
	const on = vi.fn((event: string, handler: Handler) => {
		if (!handlers.has(event)) handlers.set(event, [])
		handlers.get(event)?.push(handler)
	})
	const api = {
		on,
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI
	return { api, handlers }
}

function getHandler(handlers: Map<string, Handler[]>, event: string): Handler {
	const list = handlers.get(event)
	if (!list || list.length === 0) throw new Error(`No handler for ${event}`)
	return list[list.length - 1]
}

describe("wallClockSteerExtension", () => {
	beforeEach(() => {
		vi.resetModules()
		vi.doMock("./agent-worker-context.js", () => ({ isAgentWorker: () => false }))
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("fires steers at the right thresholds based on elapsed time (fixed mode)", async () => {
		vi.stubEnv("KIMCHI_TASK_TIMEOUT_SECONDS", "")
		const { api, handlers } = createMockApi()
		const { default: wallClockSteerExtension } = await import("./wall-clock-steer.js")
		wallClockSteerExtension(api)

		const start = await getHandler(handlers, "session_start")({})
		expect(start).toBeUndefined()

		// 4 minutes: no steer yet (first fixed steer is at 5 min).
		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 4 * 60_000)
		await getHandler(handlers, "turn_end")()
		expect(api.sendMessage).not.toHaveBeenCalled()

		// 5 minutes: first steer fires.
		vi.setSystemTime(Date.now() + 60_000)
		await getHandler(handlers, "turn_end")()
		expect(api.sendMessage).toHaveBeenCalledTimes(1)
		expect((api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].customType).toBe(
			"wall-clock-steer",
		)
		expect((api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({
			deliverAs: "steer",
		})
		vi.useRealTimers()
	})

	it("does not repeat a steer once fired", async () => {
		vi.stubEnv("KIMCHI_TASK_TIMEOUT_SECONDS", "")
		const { api, handlers } = createMockApi()
		const { default: wallClockSteerExtension } = await import("./wall-clock-steer.js")
		wallClockSteerExtension(api)

		await getHandler(handlers, "session_start")({})

		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 6 * 60_000)
		await getHandler(handlers, "turn_end")()
		expect(api.sendMessage).toHaveBeenCalledTimes(1)

		// Same steer should not fire again.
		vi.setSystemTime(Date.now() + 60_000)
		await getHandler(handlers, "turn_end")()
		expect(api.sendMessage).toHaveBeenCalledTimes(1)
		vi.useRealTimers()
	})

	it("fires multiple steers as elapsed time crosses multiple thresholds", async () => {
		vi.stubEnv("KIMCHI_TASK_TIMEOUT_SECONDS", "")
		const { api, handlers } = createMockApi()
		const { default: wallClockSteerExtension } = await import("./wall-clock-steer.js")
		wallClockSteerExtension(api)

		await getHandler(handlers, "session_start")({})

		// Jump to 11 minutes — should fire the 5-min and 10-min steers (2 total).
		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 11 * 60_000)
		await getHandler(handlers, "turn_end")()
		expect(api.sendMessage).toHaveBeenCalledTimes(2)
		vi.useRealTimers()
	})

	it("skips subagents (isAgentWorker returns true)", async () => {
		vi.doMock("./agent-worker-context.js", () => ({ isAgentWorker: () => true }))
		vi.stubEnv("KIMCHI_TASK_TIMEOUT_SECONDS", "")
		const { api, handlers } = createMockApi()
		const { default: wallClockSteerExtension } = await import("./wall-clock-steer.js")
		wallClockSteerExtension(api)

		await getHandler(handlers, "session_start")({})

		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 10 * 60_000)
		await getHandler(handlers, "turn_end")()
		expect(api.sendMessage).not.toHaveBeenCalled()
		vi.useRealTimers()
	})

	it("resets the time window on real user input", async () => {
		vi.stubEnv("KIMCHI_TASK_TIMEOUT_SECONDS", "")
		const { api, handlers } = createMockApi()
		const { default: wallClockSteerExtension } = await import("./wall-clock-steer.js")
		wallClockSteerExtension(api)

		await getHandler(handlers, "session_start")({})

		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 6 * 60_000)
		await getHandler(handlers, "turn_end")()
		expect(api.sendMessage).toHaveBeenCalledTimes(1)

		// Real user input resets the window.
		vi.setSystemTime(Date.now() + 60_000)
		const inputHandler = getHandler(handlers, "input")
		await inputHandler({ type: "input", text: "next task", source: "user" } as unknown as InputEvent)

		// 1 minute after reset: no steer yet.
		await getHandler(handlers, "turn_end")()
		expect(api.sendMessage).toHaveBeenCalledTimes(1)
		vi.useRealTimers()
	})

	it("does not reset the window on extension-injected input", async () => {
		vi.stubEnv("KIMCHI_TASK_TIMEOUT_SECONDS", "")
		const { api, handlers } = createMockApi()
		const { default: wallClockSteerExtension } = await import("./wall-clock-steer.js")
		wallClockSteerExtension(api)

		await getHandler(handlers, "session_start")({})

		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 6 * 60_000)
		await getHandler(handlers, "turn_end")()
		expect(api.sendMessage).toHaveBeenCalledTimes(1)

		// Extension input should NOT reset the window.
		const inputHandler = getHandler(handlers, "input")
		await inputHandler(
			{ type: "input", text: "steer", source: "extension" } as unknown as InputEvent,
		)

		// The 5-min steer already fired; 10-min steer should now fire as time advanced.
		vi.setSystemTime(Date.now() + 5 * 60_000)
		await getHandler(handlers, "turn_end")()
		expect(api.sendMessage).toHaveBeenCalledTimes(2)
		vi.useRealTimers()
	})

	it("uses percentage-based steers when KIMCHI_TASK_TIMEOUT_SECONDS is set", async () => {
		vi.stubEnv("KIMCHI_TASK_TIMEOUT_SECONDS", "1000")
		const { resolveSteers } = await import("./wall-clock-steer.js")
		const steers = resolveSteers({ KIMCHI_TASK_TIMEOUT_SECONDS: "1000" })
		// 50%, 75%, 90% of 1000s = 500s, 750s, 900s.
		expect(steers.map((s) => s.thresholdMs)).toEqual([500_000, 750_000, 900_000])
	})

	it("falls back to fixed steers when KIMCHI_TASK_TIMEOUT_SECONDS is invalid", async () => {
		const { resolveSteers } = await import("./wall-clock-steer.js")
		const steers = resolveSteers({ KIMCHI_TASK_TIMEOUT_SECONDS: "not-a-number" })
		// Fixed steers: 10 entries at 5,10,15,20,25,30,40,45,50,55 min.
		expect(steers).toHaveLength(10)
		expect(steers[0].thresholdMs).toBe(5 * 60_000)
		expect(steers[9].thresholdMs).toBe(55 * 60_000)
	})

	it("falls back to fixed steers when KIMCHI_TASK_TIMEOUT_SECONDS exceeds the ceiling", async () => {
		const { resolveSteers } = await import("./wall-clock-steer.js")
		// A typo like 90000 (intending 900s) must not silently disable steers.
		const steers = resolveSteers({ KIMCHI_TASK_TIMEOUT_SECONDS: "90000" })
		expect(steers).toHaveLength(10)
		expect(steers[0].thresholdMs).toBe(5 * 60_000)
	})

	it("falls back to fixed steers when KIMCHI_TASK_TIMEOUT_SECONDS is below the floor", async () => {
		const { resolveSteers } = await import("./wall-clock-steer.js")
		const steers = resolveSteers({ KIMCHI_TASK_TIMEOUT_SECONDS: "30" })
		expect(steers).toHaveLength(10)
		expect(steers[0].thresholdMs).toBe(5 * 60_000)
	})

	it("accepts a percentage mode value at the ceiling (14400s)", async () => {
		const { resolveSteers } = await import("./wall-clock-steer.js")
		const steers = resolveSteers({ KIMCHI_TASK_TIMEOUT_SECONDS: "14400" })
		// 50%, 75%, 90% of 14400s = 7200s, 10800s, 12960s.
		expect(steers.map((s) => s.thresholdMs)).toEqual([
			7_200_000, 10_800_000, 12_960_000,
		])
	})

	it("does nothing before session_start fires", async () => {
		vi.stubEnv("KIMCHI_TASK_TIMEOUT_SECONDS", "")
		const { api, handlers } = createMockApi()
		const { default: wallClockSteerExtension } = await import("./wall-clock-steer.js")
		wallClockSteerExtension(api)

		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 10 * 60_000)
		await getHandler(handlers, "turn_end")()
		expect(api.sendMessage).not.toHaveBeenCalled()
		vi.useRealTimers()
	})
})
