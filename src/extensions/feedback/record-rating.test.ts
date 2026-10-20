import { beforeEach, describe, expect, it, vi } from "vitest"
import { recordRating } from "./record-rating.js"

const feedbackMock = vi.hoisted(() => ({ trackFeedback: vi.fn() }))
vi.mock("../telemetry/index.js", () => ({
	trackFeedback: feedbackMock.trackFeedback,
}))

beforeEach(() => {
	feedbackMock.trackFeedback.mockReset()
})

describe("recordRating", () => {
	it("reports recorded even when telemetry throws — the entry is the record", () => {
		// The transcript entry is written first; if telemetry failed AFTER that,
		// the record must still be "recorded" — otherwise the caller keeps the
		// rating window armed and a retry writes a second entry for the same
		// settled response. Telemetry is best-effort everywhere in this codebase.
		const appendEntry = vi.fn()
		feedbackMock.trackFeedback.mockImplementation(() => {
			throw new Error("telemetry down")
		})

		const result = recordRating({
			appendEntry,
			sentiment: "positive",
			reason: "Solved my task",
			window: { autoModelUsed: false, routedModelId: undefined },
		})

		expect(result).toEqual({ status: "recorded" })
		expect(appendEntry).toHaveBeenCalledWith("feedback-summary", { sentiment: "positive", reason: "Solved my task" })
	})

	it("appends a feedback-summary entry and tracks telemetry with the predefined reason type", () => {
		const appendEntry = vi.fn()
		const result = recordRating({
			appendEntry,
			sentiment: "positive",
			reason: "Solved my task",
			window: { autoModelUsed: false, routedModelId: undefined },
		})

		expect(result).toEqual({ status: "recorded" })
		expect(appendEntry).toHaveBeenCalledWith("feedback-summary", {
			sentiment: "positive",
			reason: "Solved my task",
		})
		expect(feedbackMock.trackFeedback).toHaveBeenCalledWith({
			sentiment: "positive",
			reason: "Solved my task",
			reasonType: "predefined",
			routingModelId: undefined,
		})
	})

	it("tags a typed custom text as freeform (never shows the typed text as a predefined label)", () => {
		const appendEntry = vi.fn()
		recordRating({
			appendEntry,
			sentiment: "negative",
			reason: "it confused my two repos",
			window: { autoModelUsed: false, routedModelId: undefined },
		})

		expect(feedbackMock.trackFeedback).toHaveBeenCalledWith(
			expect.objectContaining({ reasonType: "freeform", reason: "it confused my two repos" }),
		)
	})

	it("clamps the reason to the shared 300-char cap in both the entry and telemetry", () => {
		const appendEntry = vi.fn()
		const longReason = "x".repeat(400)
		recordRating({
			appendEntry,
			sentiment: "negative",
			reason: longReason,
			window: { autoModelUsed: false, routedModelId: undefined },
		})

		const clamped = "x".repeat(300)
		expect(appendEntry).toHaveBeenCalledWith("feedback-summary", { sentiment: "negative", reason: clamped })
		expect(feedbackMock.trackFeedback).toHaveBeenCalledWith(expect.objectContaining({ reason: clamped }))
	})

	it("reports the routed pick for an auto settle, not the requested virtual id", () => {
		const appendEntry = vi.fn()
		recordRating({
			appendEntry,
			sentiment: "positive",
			reason: "Auto picked the right model",
			window: { autoModelUsed: true, routedModelId: "glm-5.3" },
		})

		expect(feedbackMock.trackFeedback).toHaveBeenCalledWith(expect.objectContaining({ routingModelId: "glm-5.3" }))
	})

	it("omits routingModelId when the auto pick hasn't resolved yet", () => {
		const appendEntry = vi.fn()
		recordRating({
			appendEntry,
			sentiment: "negative",
			reason: "Auto picked the wrong model",
			window: { autoModelUsed: true, routedModelId: undefined },
		})

		expect(feedbackMock.trackFeedback).toHaveBeenCalledWith(expect.objectContaining({ routingModelId: undefined }))
	})

	it("omits routingModelId for a non-auto settle even when a pick id is present", () => {
		const appendEntry = vi.fn()
		recordRating({
			appendEntry,
			sentiment: "positive",
			reason: "Fast response",
			window: { autoModelUsed: false, routedModelId: "glm-5.3" },
		})

		expect(feedbackMock.trackFeedback).toHaveBeenCalledWith(expect.objectContaining({ routingModelId: undefined }))
	})

	it("allows an empty reason — a deliberate 'no reason' submission", () => {
		const appendEntry = vi.fn()
		recordRating({
			appendEntry,
			sentiment: "positive",
			reason: "",
			window: { autoModelUsed: false, routedModelId: undefined },
		})

		expect(appendEntry).toHaveBeenCalledWith("feedback-summary", { sentiment: "positive", reason: "" })
		expect(feedbackMock.trackFeedback).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "", reasonType: "freeform" }),
		)
	})
})
