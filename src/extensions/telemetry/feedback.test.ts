import { afterEach, describe, expect, it, vi } from "vitest"
import { clampReason, MAX_REASON_LENGTH, trackFeedback, trackModelSwitchFeedback } from "./feedback.js"
import * as telemetryIndex from "./index.js"
import { _getTelemetryCtx, _isTelemetryEnabled } from "./index.js"

vi.mock("../ferment/index.js", () => ({
	getActiveFerment: vi.fn(() => undefined),
}))

const RATING_SURVEY_ID = "01a0c519-1b63-0000-0806-99c16c6d6c18"
const RATING_Q1_ID = "79c36d2a-4367-4340-b16f-8e9fb5386dca"
const RATING_Q2_ID = "be146fb0-9838-45f8-998b-8be74067234f"
const MODEL_SWITCH_SURVEY_ID = "01a0c528-75ba-0000-1ec3-bc9506dd1698"
const MODEL_SWITCH_Q_ID = "4dedb581-91f4-4d68-8cd5-e4a9f6eb726e"

const TEST_TRACE = { "request.trace_id": "aaaabbbbccccddddeeeeffff00001111", "request.span_id": "1122334455667788" }

interface FakeCtx {
	emit: ReturnType<typeof vi.fn>
	getTraceAttributes: () => Record<string, string>
}

function enableTelemetry(traceAttrs: Record<string, string> | null = TEST_TRACE): FakeCtx {
	const ctx: FakeCtx = { emit: vi.fn(), getTraceAttributes: () => traceAttrs ?? {} }
	vi.spyOn(telemetryIndex, "_isTelemetryEnabled").mockReturnValue(true)
	vi.spyOn(telemetryIndex, "_getTelemetryCtx").mockReturnValue(ctx as never)
	return ctx
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isUUID = expect.stringMatching(UUID_RE)

describe("post-turn feedback telemetry", () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
		vi.restoreAllMocks()
	})

	it("exposes the enabled guard and is a no-op when telemetry is disabled", () => {
		expect(typeof trackFeedback).toBe("function")
		expect(_isTelemetryEnabled()).toBe(false)
		expect(_getTelemetryCtx()).toBeUndefined()
		expect(() =>
			trackFeedback({
				sentiment: "positive",
				reason: "Solved my task",
				reasonType: "predefined",
				autoModelUsed: false,
			}),
		).not.toThrow()
		expect(() =>
			trackModelSwitchFeedback({ reason: "too slow", modelName: "Claude", modelId: "claude-sonnet" }),
		).not.toThrow()
	})

	it("emits no survey event when telemetry is disabled even if a ctx exists", () => {
		const emit = vi.fn()
		vi.spyOn(telemetryIndex, "_isTelemetryEnabled").mockReturnValue(false)
		vi.spyOn(telemetryIndex, "_getTelemetryCtx").mockReturnValue({ emit } as never)

		trackFeedback({ sentiment: "positive", reason: "x", reasonType: "predefined", autoModelUsed: false })
		trackModelSwitchFeedback({ reason: "x", modelName: "Claude", modelId: "claude-sonnet" })

		expect(emit).not.toHaveBeenCalled()
	})

	describe("trackFeedback", () => {
		it("emits one survey_answered with both questions when a reason is provided", () => {
			const ctx = enableTelemetry()

			trackFeedback({ sentiment: "negative", reason: "Too slow", reasonType: "predefined", autoModelUsed: true })

			expect(_isTelemetryEnabled()).toBe(true)
			expect(ctx.emit).toHaveBeenCalledTimes(1)
			expect(ctx.emit).toHaveBeenCalledWith("survey_answered", {
				survey_id: RATING_SURVEY_ID,
				survey_submission_id: isUUID,
				question_id: RATING_Q1_ID,
				answer_value: "Bad",
				question_id_2: RATING_Q2_ID,
				answer_value_2: "Too slow",
				survey_completed: true,
				...TEST_TRACE,
				auto_model_used: true,
				reason_type: "predefined",
			})
		})

		it("maps positive sentiment to the exact PostHog choice label 'Good'", () => {
			const ctx = enableTelemetry()

			trackFeedback({ sentiment: "positive", reason: "", reasonType: "predefined", autoModelUsed: false })

			expect(ctx.emit).toHaveBeenCalledWith("survey_answered", expect.objectContaining({ answer_value: "Good" }))
		})

		it("omits the second question entirely when the reason is empty", () => {
			const ctx = enableTelemetry()

			trackFeedback({ sentiment: "positive", reason: "", reasonType: "predefined", autoModelUsed: false })

			const attrs = ctx.emit.mock.calls[0][1] as Record<string, unknown>
			expect(attrs).not.toHaveProperty("question_id_2")
			expect(attrs).not.toHaveProperty("answer_value_2")
		})

		it("omits the request trace attrs when no provider request has happened yet", () => {
			const ctx = enableTelemetry(null)

			trackFeedback({ sentiment: "positive", reason: "", reasonType: "predefined", autoModelUsed: false })

			const attrs = ctx.emit.mock.calls[0][1] as Record<string, unknown>
			expect(attrs).not.toHaveProperty("request.trace_id")
			expect(attrs).not.toHaveProperty("request.span_id")
			expect(attrs).not.toHaveProperty("turn_index")
		})

		it("carries the reason verbatim and marks typed answers as freeform", () => {
			const ctx = enableTelemetry()

			trackFeedback({
				sentiment: "negative",
				reason: "broke on /Users/me/secret-project",
				reasonType: "freeform",
				autoModelUsed: false,
			})

			expect(ctx.emit).toHaveBeenCalledWith(
				"survey_answered",
				expect.objectContaining({
					question_id_2: RATING_Q2_ID,
					answer_value_2: "broke on /Users/me/secret-project",
					reason_type: "freeform",
				}),
			)
		})

		it("mints a unique survey_submission_id per call", () => {
			const ctx = enableTelemetry()

			trackFeedback({ sentiment: "positive", reason: "", reasonType: "predefined", autoModelUsed: false })
			trackFeedback({ sentiment: "positive", reason: "", reasonType: "predefined", autoModelUsed: false })

			const ids = ctx.emit.mock.calls.map((c) => (c[1] as Record<string, unknown>).survey_submission_id)
			expect(ids[0]).toMatch(UUID_RE)
			expect(ids[1]).toMatch(UUID_RE)
			expect(ids[0]).not.toBe(ids[1])
		})
	})

	describe("trackModelSwitchFeedback", () => {
		it("emits one survey_answered with the raw reason, request trace and model_id", () => {
			const ctx = enableTelemetry()

			trackModelSwitchFeedback({
				reason: "too expensive for this repo",
				modelName: "Claude Sonnet",
				modelId: "claude-sonnet-4-6",
			})

			expect(ctx.emit).toHaveBeenCalledTimes(1)
			expect(ctx.emit).toHaveBeenCalledWith("survey_answered", {
				survey_id: MODEL_SWITCH_SURVEY_ID,
				survey_submission_id: isUUID,
				question_id: MODEL_SWITCH_Q_ID,
				answer_value: "too expensive for this repo",
				survey_completed: true,
				...TEST_TRACE,
				model_id: "claude-sonnet-4-6",
			})
		})
	})
})

describe("clampReason", () => {
	it("passes through a reason at or under the cap unchanged", () => {
		const exact = "x".repeat(MAX_REASON_LENGTH)
		expect(clampReason(exact)).toEqual({ value: exact, truncated: false })
		expect(clampReason("short")).toEqual({ value: "short", truncated: false })
		expect(clampReason("")).toEqual({ value: "", truncated: false })
	})

	it("cuts an oversized reason to the cap and reports it", () => {
		const result = clampReason("y".repeat(MAX_REASON_LENGTH + 1))
		expect(result.value).toHaveLength(MAX_REASON_LENGTH)
		expect(result.truncated).toBe(true)
	})

	it("bounds a pasted payload far larger than the cap", () => {
		// The editor accepts bracketed paste, so this is the realistic abuse
		// case: a whole log or file pasted into the reason field.
		const result = clampReason("z".repeat(500_000))
		expect(result.value).toHaveLength(MAX_REASON_LENGTH)
		expect(result.truncated).toBe(true)
	})
})

describe("free-form reason size limits on emitted events", () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
		vi.restoreAllMocks()
	})

	it("caps an oversized rating reason and flags it on the event", () => {
		const ctx = enableTelemetry()

		trackFeedback({
			sentiment: "negative",
			reason: "p".repeat(100_000),
			reasonType: "freeform",
			autoModelUsed: false,
		})

		const attrs = ctx.emit.mock.calls[0]?.[1] as Record<string, unknown>
		expect(String(attrs.answer_value_2)).toHaveLength(MAX_REASON_LENGTH)
		expect(attrs.reason_truncated).toBe(true)
	})

	it("caps an oversized model-switch reason and flags it on the event", () => {
		const ctx = enableTelemetry()

		trackModelSwitchFeedback({ reason: "q".repeat(100_000), modelName: "M", modelId: "m" })

		const attrs = ctx.emit.mock.calls[0]?.[1] as Record<string, unknown>
		expect(String(attrs.answer_value)).toHaveLength(MAX_REASON_LENGTH)
		expect(attrs.reason_truncated).toBe(true)
	})

	it("leaves a normal reason unflagged", () => {
		const ctx = enableTelemetry()

		trackFeedback({ sentiment: "positive", reason: "worked well", reasonType: "freeform", autoModelUsed: false })

		const attrs = ctx.emit.mock.calls[0]?.[1] as Record<string, unknown>
		expect(attrs.answer_value_2).toBe("worked well")
		expect(attrs).not.toHaveProperty("reason_truncated")
	})
})
