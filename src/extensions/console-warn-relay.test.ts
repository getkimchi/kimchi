import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	installConsoleWarnRelay,
	resetConsoleWarnRelayForTests,
	trackConsoleWarnRelayContext,
} from "./console-warn-relay.js"
import { recordRelayedWarning } from "./warnings-summary.js"

vi.mock("./warnings-summary.js", () => ({
	recordRelayedWarning: vi.fn(),
}))

const mockedRecord = vi.mocked(recordRelayedWarning)

const pristineWarn = console.warn

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(0)
})

afterEach(() => {
	vi.useRealTimers()
	resetConsoleWarnRelayForTests()
	console.warn = pristineWarn
	mockedRecord.mockClear()
})

function fakeCtx(hasUI: boolean) {
	return { hasUI } as ExtensionContext
}

/** The relay captures whatever console.warn is current at install time as its sink. */
function installWithSink(sink: (...args: unknown[]) => void): void {
	console.warn = sink as typeof console.warn
	installConsoleWarnRelay()
}

describe("installConsoleWarnRelay", () => {
	it("reroutes every warn to the warnings store in interactive mode, prefix or not", () => {
		const sink = vi.fn()
		installWithSink(sink)
		trackConsoleWarnRelayContext(fakeCtx(true))

		console.warn("unrelated", 42)

		expect(mockedRecord).toHaveBeenCalledTimes(1)
		expect(mockedRecord).toHaveBeenCalledWith("unrelated 42")
		expect(sink).not.toHaveBeenCalled()
	})

	it("strips ANSI escapes before recording", () => {
		const sink = vi.fn()
		installWithSink(sink)
		trackConsoleWarnRelayContext(fakeCtx(true))

		console.warn("[33mWarning: resolver fell back[39m")

		expect(mockedRecord).toHaveBeenCalledTimes(1)
		expect(mockedRecord).toHaveBeenCalledWith("Warning: resolver fell back")
		expect(sink).not.toHaveBeenCalled()
	})

	it("formats arguments like the terminal would — placeholders resolved, objects inspected", () => {
		installWithSink(vi.fn())
		trackConsoleWarnRelayContext(fakeCtx(true))

		console.warn("server %s failed:", "github", { code: 42 })

		expect(mockedRecord).toHaveBeenCalledWith("server github failed: { code: 42 }")
	})

	it("strips OSC sequences (hyperlinks, window titles) before recording", () => {
		installWithSink(vi.fn())
		trackConsoleWarnRelayContext(fakeCtx(true))

		console.warn("see \u001b]8;;https://example.com\u0007docs\u001b]8;;\u0007 \u001b]0;title\u001b\\now")

		expect(mockedRecord).toHaveBeenCalledWith("see docs now")
	})

	it("dedupes colored and uncolored variants of the same message together", () => {
		const sink = vi.fn()
		installWithSink(sink)
		trackConsoleWarnRelayContext(fakeCtx(true))

		console.warn("[33mWarning: resolver fell back[39m")
		console.warn("Warning: resolver fell back")

		expect(mockedRecord).toHaveBeenCalledTimes(1)
		expect(mockedRecord).toHaveBeenCalledWith("Warning: resolver fell back")
	})

	it("dedupes identical messages within the window; distinct messages and post-window repeats record", () => {
		const sink = vi.fn()
		installWithSink(sink)
		trackConsoleWarnRelayContext(fakeCtx(true))

		console.warn("same message")
		console.warn("same message")
		console.warn("same message")
		console.warn("different message")

		expect(mockedRecord).toHaveBeenCalledTimes(2)
		expect(mockedRecord).toHaveBeenNthCalledWith(1, "same message")
		expect(mockedRecord).toHaveBeenNthCalledWith(2, "different message")

		vi.setSystemTime(10_001)
		console.warn("same message")

		expect(mockedRecord).toHaveBeenCalledTimes(3)
		expect(sink).not.toHaveBeenCalled()
	})

	it("passes warns to the original sink verbatim when headless — ANSI preserved, repeats not deduped", () => {
		const sink = vi.fn()
		installWithSink(sink)
		trackConsoleWarnRelayContext(fakeCtx(false))

		console.warn("[33mMCP: 105 direct tools resolved.[39m")
		console.warn("MCP: 105 direct tools resolved.")
		console.warn("MCP: 105 direct tools resolved.")

		expect(mockedRecord).not.toHaveBeenCalled()
		expect(sink).toHaveBeenCalledTimes(3)
		expect(sink).toHaveBeenNthCalledWith(1, "[33mMCP: 105 direct tools resolved.[39m")
		expect(sink).toHaveBeenNthCalledWith(2, "MCP: 105 direct tools resolved.")
		expect(sink).toHaveBeenNthCalledWith(3, "MCP: 105 direct tools resolved.")
	})

	it("uses the latest tracked context after session switches and clears dedupe state", () => {
		installWithSink(vi.fn())
		trackConsoleWarnRelayContext(fakeCtx(true))

		console.warn("MCP: switched")
		expect(mockedRecord).toHaveBeenCalledTimes(1)

		trackConsoleWarnRelayContext(fakeCtx(true))
		console.warn("MCP: switched")

		expect(mockedRecord).toHaveBeenCalledTimes(2)
		expect(mockedRecord).toHaveBeenNthCalledWith(2, "MCP: switched")
	})

	it("is idempotent — repeat installs do not stack wrappers", () => {
		const sink = vi.fn()
		console.warn = sink as typeof console.warn
		installConsoleWarnRelay()
		installConsoleWarnRelay()
		trackConsoleWarnRelayContext(fakeCtx(true))

		console.warn("once")

		expect(mockedRecord).toHaveBeenCalledTimes(1)
		expect(sink).not.toHaveBeenCalled()
	})

	it("keeps the dedupe map bounded without swallowing distinct messages", () => {
		const sink = vi.fn()
		installWithSink(sink)
		trackConsoleWarnRelayContext(fakeCtx(true))

		for (let i = 0; i < 300; i++) console.warn(`warn ${i}`)

		expect(mockedRecord).toHaveBeenCalledTimes(300)
		expect(sink).not.toHaveBeenCalled()
	})

	it("queues pre-track warns and routes them into the store on first interactive track", () => {
		const sink = vi.fn()
		installWithSink(sink)

		console.warn("early warning one")
		console.warn("early warning two")
		expect(sink).not.toHaveBeenCalled()
		expect(mockedRecord).not.toHaveBeenCalled()

		trackConsoleWarnRelayContext(fakeCtx(true))

		expect(mockedRecord).toHaveBeenCalledTimes(2)
		expect(mockedRecord).toHaveBeenNthCalledWith(1, "early warning one")
		expect(mockedRecord).toHaveBeenNthCalledWith(2, "early warning two")
		expect(sink).not.toHaveBeenCalled()
	})

	it("drains queued pre-track warns to the sink verbatim on first headless track", () => {
		const sink = vi.fn()
		installWithSink(sink)

		console.warn("early warning")
		console.warn("early warning")
		trackConsoleWarnRelayContext(fakeCtx(false))

		expect(mockedRecord).not.toHaveBeenCalled()
		expect(sink).toHaveBeenCalledTimes(2)
		expect(sink).toHaveBeenNthCalledWith(1, "early warning")
		expect(sink).toHaveBeenNthCalledWith(2, "early warning")

		// Post-track, headless passes through directly without queueing.
		console.warn("late warning")
		expect(sink).toHaveBeenCalledTimes(3)
	})

	it("bounds the pre-track queue — overflow drains oldest to the sink in order", () => {
		const sink = vi.fn()
		installWithSink(sink)

		for (let i = 0; i < 25; i++) console.warn(`queued ${i}`)
		expect(sink).toHaveBeenCalledTimes(5)
		expect(sink).toHaveBeenNthCalledWith(1, "queued 0")
		expect(sink).toHaveBeenNthCalledWith(5, "queued 4")

		trackConsoleWarnRelayContext(fakeCtx(true))
		expect(mockedRecord).toHaveBeenCalledTimes(20)
		expect(mockedRecord).toHaveBeenNthCalledWith(1, "queued 5")
	})

	it("flushes never-tracked queued warns to the sink on process exit", () => {
		const sink = vi.fn()
		installWithSink(sink)
		console.warn("fired before an early exit", 1)

		process.emit("exit", 1)

		expect(sink).toHaveBeenCalledWith("fired before an early exit", 1)
		expect(mockedRecord).not.toHaveBeenCalled()
	})

	it("reset removes the exit flush listener", () => {
		const listenersBefore = process.listenerCount("exit")
		installWithSink(vi.fn())
		expect(process.listenerCount("exit")).toBe(listenersBefore + 1)

		resetConsoleWarnRelayForTests()

		expect(process.listenerCount("exit")).toBe(listenersBefore)
	})

	it("reset restores the original sink and clears tracked context and dedupe state", () => {
		const sink = vi.fn()
		installWithSink(sink)
		trackConsoleWarnRelayContext(fakeCtx(true))

		console.warn("transient")
		expect(mockedRecord).toHaveBeenCalledTimes(1)

		resetConsoleWarnRelayForTests()
		console.warn("transient")

		expect(mockedRecord).toHaveBeenCalledTimes(1)
		expect(sink).toHaveBeenCalledWith("transient")
	})
})

describe("installConsoleWarnRelay errors", () => {
	it("falls back to the original sink when recording throws — console.warn never throws", () => {
		const sink = vi.fn()
		installWithSink(sink)
		mockedRecord.mockImplementationOnce(() => {
			throw new Error("host rejected sendMessage")
		})
		console.warn("queued behind the failure")
		console.warn("first", "queued")

		expect(() => trackConsoleWarnRelayContext(fakeCtx(true))).not.toThrow()
		expect(sink).toHaveBeenCalledWith("queued behind the failure")
		expect(mockedRecord).toHaveBeenLastCalledWith("first queued")

		mockedRecord.mockImplementationOnce(() => {
			throw new Error("host rejected sendMessage")
		})
		expect(() => console.warn("live failure")).not.toThrow()
		expect(sink).toHaveBeenLastCalledWith("live failure")
	})
})
