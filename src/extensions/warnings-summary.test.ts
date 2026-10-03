import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import {
	recordRelayedWarning,
	resetWarningsSummaryForTests,
	trackWarningsSummaryContext,
	WARNING_AGGREGATE_WINDOW_MS,
	WARNINGS_SUMMARY_MESSAGE_TYPE,
} from "./warnings-summary.js"

beforeEach(() => {
	resetWarningsSummaryForTests()
	vi.useFakeTimers()
})

afterEach(() => {
	resetWarningsSummaryForTests()
	vi.useRealTimers()
})

describe("recordRelayedWarning", () => {
	it("aggregates warnings fired together into one collapsed transcript block", () => {
		const harness = createExtensionApi()
		const ctx = createContext()
		trackWarningsSummaryContext(ctx, harness.api)

		recordRelayedWarning("first warning")
		recordRelayedWarning("second warning")
		recordRelayedWarning("third issue\nwith detail")
		expect(harness.sendMessage).not.toHaveBeenCalled()

		vi.advanceTimersByTime(WARNING_AGGREGATE_WINDOW_MS)

		expect(harness.sendMessage).toHaveBeenCalledTimes(1)
		expect(harness.sendMessage).toHaveBeenCalledWith(
			{
				customType: WARNINGS_SUMMARY_MESSAGE_TYPE,
				// The LLM only sees this one-line annotation; the full list of
				// warnings lives in display-only details.
				content: [{ type: "text", text: "<system-annotation>Console warnings (3) relayed</system-annotation>" }],
				display: true,
				details: {
					summary: "[3 warnings] Latest: third issue with detail",
					title: "[Warnings]",
					entries: ["first warning", "second warning", "third issue\nwith detail"],
				},
			},
			{ triggerTurn: false },
		)
		// No editor widget is touched at any point — nothing stays pinned.
		expect(ctx.ui.setWidget).not.toHaveBeenCalled()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("keeps the single-warning shape when only one warning fired in the window", () => {
		const harness = createExtensionApi()
		trackWarningsSummaryContext(createContext(), harness.api)

		recordRelayedWarning("lonely warning")
		vi.advanceTimersByTime(WARNING_AGGREGATE_WINDOW_MS)

		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: [{ type: "text", text: "<system-annotation>Console warning relayed</system-annotation>" }],
				details: { summary: "[Warning] lonely warning", title: "[Warning]", entries: ["lonely warning"] },
			}),
			{ triggerTurn: false },
		)
	})

	it("throttles from the first warning — a continuous stream flushes every window, never defers forever", () => {
		const harness = createExtensionApi()
		trackWarningsSummaryContext(createContext(), harness.api)

		recordRelayedWarning("window one")
		vi.advanceTimersByTime(WARNING_AGGREGATE_WINDOW_MS - 1)
		recordRelayedWarning("still window one") // does not reset the timer

		vi.advanceTimersByTime(1)
		expect(harness.sendMessage).toHaveBeenCalledTimes(1)
		expect(vi.mocked(harness.sendMessage).mock.calls[0][0].details).toEqual(
			expect.objectContaining({ entries: ["window one", "still window one"] }),
		)

		recordRelayedWarning("window two")
		vi.advanceTimersByTime(WARNING_AGGREGATE_WINDOW_MS)
		expect(harness.sendMessage).toHaveBeenCalledTimes(2)
		expect(vi.mocked(harness.sendMessage).mock.calls[1][0].details).toEqual(
			expect.objectContaining({ summary: "[Warning] window two", entries: ["window two"] }),
		)
	})

	it("flushes buffered warnings into the previous session when the session is re-tracked", () => {
		const firstHarness = createExtensionApi()
		trackWarningsSummaryContext(createContext(), firstHarness.api)
		recordRelayedWarning("old session warning")

		const secondHarness = createExtensionApi()
		trackWarningsSummaryContext(createContext(), secondHarness.api)
		expect(firstHarness.sendMessage).toHaveBeenCalledTimes(1)

		recordRelayedWarning("fresh session warning")
		vi.advanceTimersByTime(WARNING_AGGREGATE_WINDOW_MS)
		expect(firstHarness.sendMessage).toHaveBeenCalledTimes(1)
		expect(secondHarness.sendMessage).toHaveBeenCalledTimes(1)
		expect(vi.mocked(secondHarness.sendMessage).mock.calls[0][0].details).toEqual(
			expect.objectContaining({ entries: ["fresh session warning"] }),
		)
	})
})

describe("recordRelayedWarning fallbacks", () => {
	it("falls back to ctx.ui.notify immediately when the tracked context has no UI", () => {
		const headless = createContext({ hasUI: false })
		trackWarningsSummaryContext(headless, createExtensionApi().api)

		recordRelayedWarning("headless-ish warning")

		expect(headless.ui.notify).toHaveBeenCalledWith("headless-ish warning", "warning")
	})

	it("falls back to ctx.ui.notify immediately when no session API has been tracked", () => {
		const ctx = createContext()
		trackWarningsSummaryContext(ctx)

		recordRelayedWarning("tracked context, no API")

		expect(ctx.ui.notify).toHaveBeenCalledWith("tracked context, no API", "warning")
	})
})
