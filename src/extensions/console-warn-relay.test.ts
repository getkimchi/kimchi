import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	installConsoleWarnRelay,
	resetConsoleWarnRelayForTests,
	trackConsoleWarnRelayContext,
} from "./console-warn-relay.js"

const pristineWarn = console.warn

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(0)
})

afterEach(() => {
	vi.useRealTimers()
	resetConsoleWarnRelayForTests()
	console.warn = pristineWarn
})

function fakeCtx(hasUI: boolean) {
	return {
		hasUI,
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext & { ui: { notify: ReturnType<typeof vi.fn> } }
}

/** The relay captures whatever console.warn is current at install time as its sink. */
function installWithSink(sink: (...args: unknown[]) => void): void {
	console.warn = sink as typeof console.warn
	installConsoleWarnRelay()
}

describe("installConsoleWarnRelay", () => {
	it("reroutes every warn to ui.notify in interactive mode, prefix or not", () => {
		const sink = vi.fn()
		const ctx = fakeCtx(true)
		installWithSink(sink)
		trackConsoleWarnRelayContext(ctx)

		console.warn("unrelated", 42)

		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(ctx.ui.notify).toHaveBeenCalledWith("unrelated 42", "warning")
		expect(sink).not.toHaveBeenCalled()
	})

	it("strips ANSI escapes from the notified message", () => {
		const sink = vi.fn()
		const ctx = fakeCtx(true)
		installWithSink(sink)
		trackConsoleWarnRelayContext(ctx)

		console.warn("\u001b[33mWarning: resolver fell back\u001b[39m")

		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(ctx.ui.notify).toHaveBeenCalledWith("Warning: resolver fell back", "warning")
		expect(sink).not.toHaveBeenCalled()
	})

	it("dedupes colored and uncolored variants of the same message together", () => {
		const sink = vi.fn()
		const ctx = fakeCtx(true)
		installWithSink(sink)
		trackConsoleWarnRelayContext(ctx)

		console.warn("\u001b[33mWarning: resolver fell back\u001b[39m")
		console.warn("Warning: resolver fell back")

		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(ctx.ui.notify).toHaveBeenCalledWith("Warning: resolver fell back", "warning")
	})

	it("dedupes identical messages within the window; distinct messages and post-window repeats notify", () => {
		const sink = vi.fn()
		const ctx = fakeCtx(true)
		installWithSink(sink)
		trackConsoleWarnRelayContext(ctx)

		console.warn("same message")
		console.warn("same message")
		console.warn("same message")
		console.warn("different message")

		expect(ctx.ui.notify).toHaveBeenCalledTimes(2)
		expect(ctx.ui.notify).toHaveBeenNthCalledWith(1, "same message", "warning")
		expect(ctx.ui.notify).toHaveBeenNthCalledWith(2, "different message", "warning")

		vi.setSystemTime(10_001)
		console.warn("same message")

		expect(ctx.ui.notify).toHaveBeenCalledTimes(3)
		expect(sink).not.toHaveBeenCalled()
	})

	it("passes warns to the original sink verbatim when headless — ANSI preserved, repeats not deduped", () => {
		const sink = vi.fn()
		const ctx = fakeCtx(false)
		installWithSink(sink)
		trackConsoleWarnRelayContext(ctx)

		console.warn("\u001b[33mMCP: 105 direct tools resolved.\u001b[39m")
		console.warn("MCP: 105 direct tools resolved.")
		console.warn("MCP: 105 direct tools resolved.")

		expect(ctx.ui.notify).not.toHaveBeenCalled()
		expect(sink).toHaveBeenCalledTimes(3)
		expect(sink).toHaveBeenNthCalledWith(1, "\u001b[33mMCP: 105 direct tools resolved.\u001b[39m")
		expect(sink).toHaveBeenNthCalledWith(2, "MCP: 105 direct tools resolved.")
		expect(sink).toHaveBeenNthCalledWith(3, "MCP: 105 direct tools resolved.")
	})

	it("uses the latest tracked context after session switches and clears dedupe state", () => {
		const first = fakeCtx(true)
		const second = fakeCtx(true)
		installWithSink(vi.fn())
		trackConsoleWarnRelayContext(first)

		console.warn("MCP: switched")
		expect(first.ui.notify).toHaveBeenCalledTimes(1)

		trackConsoleWarnRelayContext(second)
		console.warn("MCP: switched")

		expect(first.ui.notify).toHaveBeenCalledTimes(1)
		expect(second.ui.notify).toHaveBeenCalledWith("MCP: switched", "warning")
	})

	it("is idempotent — repeat installs do not stack wrappers", () => {
		const sink = vi.fn()
		const ctx = fakeCtx(true)
		console.warn = sink as typeof console.warn
		installConsoleWarnRelay()
		installConsoleWarnRelay()
		trackConsoleWarnRelayContext(ctx)

		console.warn("once")

		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(sink).not.toHaveBeenCalled()
	})

	it("keeps the dedupe map bounded without swallowing distinct messages", () => {
		const sink = vi.fn()
		const ctx = fakeCtx(true)
		installWithSink(sink)
		trackConsoleWarnRelayContext(ctx)

		for (let i = 0; i < 300; i++) console.warn(`warn ${i}`)

		expect(ctx.ui.notify).toHaveBeenCalledTimes(300)
		expect(sink).not.toHaveBeenCalled()
	})

	it("reset restores the original sink and clears tracked context and dedupe state", () => {
		const sink = vi.fn()
		const ctx = fakeCtx(true)
		installWithSink(sink)
		trackConsoleWarnRelayContext(ctx)

		console.warn("transient")
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)

		resetConsoleWarnRelayForTests()
		console.warn("transient")

		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(sink).toHaveBeenCalledWith("transient")
	})
})
