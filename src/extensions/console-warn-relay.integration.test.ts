import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import consoleWarnRelayExtension, { resetConsoleWarnRelayForTests } from "./console-warn-relay.js"
import {
	resetWarningsSummaryForTests,
	WARNING_AGGREGATE_WINDOW_MS,
	WARNINGS_SUMMARY_MESSAGE_TYPE,
} from "./warnings-summary.js"

async function startSession(harness: ReturnType<typeof createExtensionApi>, ctx = createContext()) {
	await harness.getHandler("session_start")({ type: "session_start", reason: "startup" }, ctx)
	return ctx
}

describe("consoleWarnRelayExtension", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
		resetConsoleWarnRelayForTests()
		resetWarningsSummaryForTests()
		vi.restoreAllMocks()
	})

	it("prints a relayed warn as one collapsed transcript row after the aggregation window", async () => {
		const sink = vi.spyOn(console, "warn").mockImplementation(() => {})
		const harness = createExtensionApi()
		consoleWarnRelayExtension(harness.api)
		const ctx = await startSession(harness)

		console.warn("[kimchi-update] Ignoring malformed auto-update state at /tmp/state.json")
		expect(harness.sendMessage).not.toHaveBeenCalled()

		vi.advanceTimersByTime(WARNING_AGGREGATE_WINDOW_MS)

		expect(harness.sendMessage).toHaveBeenCalledWith(
			{
				customType: WARNINGS_SUMMARY_MESSAGE_TYPE,
				// The LLM only sees this one-line annotation; the warning text
				// lives in display-only details above it.
				content: [{ type: "text", text: "<system-annotation>Console warning relayed</system-annotation>" }],
				display: true,
				details: {
					summary: "[Warning] [kimchi-update] Ignoring malformed auto-update state at /tmp/state.json",
					title: "[Warning]",
					entries: ["[kimchi-update] Ignoring malformed auto-update state at /tmp/state.json"],
				},
			},
			{ triggerTurn: false },
		)
		expect(sink).not.toHaveBeenCalled()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("flattens multi-line warnings into the collapsed summary while keeping the full text in details", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
		const harness = createExtensionApi()
		consoleWarnRelayExtension(harness.api)
		await startSession(harness)

		console.warn("first line\nsecond line")
		vi.advanceTimersByTime(WARNING_AGGREGATE_WINDOW_MS)

		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				details: {
					summary: "[Warning] first line second line",
					title: "[Warning]",
					entries: ["first line\nsecond line"],
				},
			}),
			{ triggerTurn: false },
		)
	})

	it("replays warns fired before session_start as one aggregated group once the session is tracked", async () => {
		const sink = vi.spyOn(console, "warn").mockImplementation(() => {})
		const harness = createExtensionApi()
		consoleWarnRelayExtension(harness.api)
		// Fired at load time or by an earlier session_start handler.
		console.warn("early warning one")
		console.warn("early warning two")

		await startSession(harness)
		expect(harness.sendMessage).not.toHaveBeenCalled()

		vi.advanceTimersByTime(WARNING_AGGREGATE_WINDOW_MS)

		expect(harness.sendMessage).toHaveBeenCalledTimes(1)
		expect(vi.mocked(harness.sendMessage).mock.calls[0][0].details).toEqual({
			summary: "[2 warnings] Latest: early warning two",
			title: "[Warnings]",
			entries: ["early warning one", "early warning two"],
		})
		expect(sink).not.toHaveBeenCalled()
	})

	it("passes warns through to the terminal sink in headless sessions", async () => {
		const sink = vi.spyOn(console, "warn").mockImplementation(() => {})
		const harness = createExtensionApi()
		consoleWarnRelayExtension(harness.api)
		await startSession(harness, createContext({ hasUI: false }))

		console.warn("headless warning")

		expect(sink).toHaveBeenCalledWith("headless warning")
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})
})
