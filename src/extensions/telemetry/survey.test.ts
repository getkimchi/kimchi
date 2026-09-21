import { afterEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../config.js"
import { _resetSharedAccumulators, TelemetryContext } from "./session-context.js"
import { emitSurveyAnswered, emitSurveyDismissed, emitSurveyShown } from "./survey.js"
import type { LogRecord } from "./transport.js"

vi.mock("../../api/me.js", () => ({
	getMe: vi.fn().mockResolvedValue({ id: "test-user", email: "test@example.com" }),
}))

const TEST_SURVEY = {
	id: "019e87cc-5033-0000-d9bd-5e6501640b6e",
	version: 1,
	question: {
		id: "34f7caf5-7631-42f1-b6ed-d2a42ddde1cd",
		text: "How did Kimchi do?",
		help: "Your feedback helps us improve.",
	},
	options: [
		{ id: "worked_great", label: "Went great" },
		{ id: "mostly_worked", label: "Mostly worked" },
		{ id: "didnt_work", label: "Didn't work" },
	],
} as const

function makeConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
	return {
		enabled: false,
		endpoint: "https://test.example.com/logs",
		metricsEndpoint: "https://test.example.com/metrics",
		headers: { Authorization: "Bearer test" },
		apiKey: "",
		...overrides,
	}
}

function attrs(record: LogRecord): Record<string, string> {
	return Object.fromEntries(
		record.attributes.map((attr) => [
			attr.key,
			"stringValue" in attr.value
				? attr.value.stringValue
				: String("intValue" in attr.value ? attr.value.intValue : attr.value.doubleValue),
		]),
	)
}

describe("survey telemetry", () => {
	afterEach(() => {
		_resetSharedAccumulators()
		vi.restoreAllMocks()
	})

	it("emits survey_shown with the survey id", async () => {
		const ctx = new TelemetryContext(makeConfig())

		emitSurveyShown(ctx, { survey: TEST_SURVEY })

		expect(ctx.logBuffer).toHaveLength(1)
		const record = ctx.logBuffer[0]
		expect(record.eventName).toBe("survey_shown")

		const attrMap = attrs(record)
		expect(attrMap.survey_id).toBe(TEST_SURVEY.id)
		expect(attrMap["session.id"]).toBe(ctx.telemetryId)
		expect(attrMap.client).toBe("pi")
		expect(attrMap.source).toBe("cli")

		await ctx.drain()
	})

	it("emits survey_answered with the abstract survey response fields", async () => {
		const ctx = new TelemetryContext(makeConfig())

		emitSurveyAnswered(ctx, { survey: TEST_SURVEY, submissionId: "submission-1", answerId: "mostly_worked" })

		expect(ctx.logBuffer).toHaveLength(1)
		const record = ctx.logBuffer[0]
		expect(record.eventName).toBe("survey_answered")

		const attrMap = attrs(record)
		expect(attrMap.survey_id).toBe(TEST_SURVEY.id)
		expect(attrMap.survey_submission_id).toBe("submission-1")
		expect(attrMap.question_id).toBe("34f7caf5-7631-42f1-b6ed-d2a42ddde1cd")
		expect(attrMap.answer_value).toBe("Mostly worked")
		expect(attrMap.survey_completed).toBe("true")

		await ctx.drain()
	})

	it("emits the second question response alongside the resolved first answer", async () => {
		const ctx = new TelemetryContext(makeConfig())

		emitSurveyAnswered(ctx, {
			survey: TEST_SURVEY,
			submissionId: "submission-1",
			answerId: "worked_great",
			secondResponse: { questionId: "q2-id", answerValue: "it nailed the refactor" },
		})

		const attrMap = attrs(ctx.logBuffer[0])
		expect(attrMap.question_id).toBe(TEST_SURVEY.question.id)
		expect(attrMap.answer_value).toBe("Went great")
		expect(attrMap.question_id_2).toBe("q2-id")
		expect(attrMap.answer_value_2).toBe("it nailed the refactor")
		expect(attrMap.survey_completed).toBe("true")

		await ctx.drain()
	})

	it("sends a raw answerValue verbatim, without an options lookup", async () => {
		const ctx = new TelemetryContext(makeConfig())
		const OPEN_SURVEY = {
			id: "survey-open",
			version: 1,
			question: { id: "open-q", text: "Tell us why you switched" },
			options: [],
		} as const

		emitSurveyAnswered(ctx, {
			survey: OPEN_SURVEY,
			submissionId: "submission-1",
			answerValue: "too expensive for this repo",
		})

		const attrMap = attrs(ctx.logBuffer[0])
		expect(ctx.logBuffer).toHaveLength(1)
		expect(attrMap.question_id).toBe("open-q")
		expect(attrMap.answer_value).toBe("too expensive for this repo")

		await ctx.drain()
	})

	it("answerValue takes precedence over the answerId lookup", async () => {
		const ctx = new TelemetryContext(makeConfig())

		emitSurveyAnswered(ctx, {
			survey: TEST_SURVEY,
			submissionId: "submission-1",
			answerId: "mostly_worked",
			answerValue: "raw override",
		})

		expect(attrs(ctx.logBuffer[0]).answer_value).toBe("raw override")

		await ctx.drain()
	})

	it("spreads extraAttrs verbatim into the emitted record", async () => {
		const ctx = new TelemetryContext(makeConfig())

		emitSurveyAnswered(ctx, {
			survey: TEST_SURVEY,
			submissionId: "submission-1",
			answerId: "worked_great",
			extraAttrs: { turn_index: 0, auto_model_used: true, reason_type: "freeform" },
		})

		const attrMap = attrs(ctx.logBuffer[0])
		// turn_index 0 is a valid value and must be present.
		expect(attrMap.turn_index).toBe("0")
		expect(attrMap.auto_model_used).toBe("true")
		expect(attrMap.reason_type).toBe("freeform")

		await ctx.drain()
	})

	it("does not emit survey_answered for an unknown answer id", async () => {
		const ctx = new TelemetryContext(makeConfig())

		emitSurveyAnswered(ctx, { survey: TEST_SURVEY, submissionId: "submission-1", answerId: "unknown" })

		expect(ctx.logBuffer).toHaveLength(0)

		await ctx.drain()
	})

	it("keeps the legacy single-question answered shape unchanged", async () => {
		// Regression: flows that don't use secondResponse/extraAttrs must emit
		// exactly the four response attrs they always did (plus envelope attrs).
		const ctx = new TelemetryContext(makeConfig())

		emitSurveyAnswered(ctx, { survey: TEST_SURVEY, submissionId: "submission-1", answerId: "didnt_work" })

		const attrMap = attrs(ctx.logBuffer[0])
		expect(attrMap.question_id_2).toBeUndefined()
		expect(attrMap.answer_value_2).toBeUndefined()
		const surveyKeys = Object.keys(attrMap).filter(
			(k) => k.startsWith("survey_") || k.startsWith("question_") || k.startsWith("answer_"),
		)
		expect(surveyKeys.sort()).toEqual([
			"answer_value",
			"question_id",
			"survey_completed",
			"survey_id",
			"survey_submission_id",
		])

		await ctx.drain()
	})

	it("emits survey_dismissed with the survey id", async () => {
		const ctx = new TelemetryContext(makeConfig())

		emitSurveyDismissed(ctx, { survey: TEST_SURVEY })

		expect(ctx.logBuffer).toHaveLength(1)
		const record = ctx.logBuffer[0]
		expect(record.eventName).toBe("survey_dismissed")

		const attrMap = attrs(record)
		expect(attrMap.survey_id).toBe(TEST_SURVEY.id)

		await ctx.drain()
	})

	it("emits triggered survey events with the survey response fields", async () => {
		const ctx = new TelemetryContext(makeConfig())

		emitSurveyShown(ctx, { survey: TEST_SURVEY, trigger: "ferment_completed" })
		emitSurveyAnswered(ctx, {
			survey: TEST_SURVEY,
			submissionId: "submission-1",
			answerId: "worked_great",
			trigger: "ferment_completed",
		})
		emitSurveyDismissed(ctx, {
			survey: TEST_SURVEY,
			trigger: "ferment_completed",
			reason: "ctrl_c",
		})

		expect(attrs(ctx.logBuffer[0]).survey_id).toBe(TEST_SURVEY.id)
		expect(attrs(ctx.logBuffer[1]).answer_value).toBe("Went great")
		expect(attrs(ctx.logBuffer[1]).survey_submission_id).toBe("submission-1")
		expect(attrs(ctx.logBuffer[1]).survey_completed).toBe("true")
		expect(attrs(ctx.logBuffer[2]).survey_id).toBe(TEST_SURVEY.id)

		await ctx.drain()
	})
})
