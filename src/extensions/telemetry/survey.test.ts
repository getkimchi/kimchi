import { afterEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../config.js"
import { SessionContext, _resetSharedAccumulators } from "./session-context.js"
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
		const ctx = new SessionContext(makeConfig(), "cli")

		emitSurveyShown(ctx, { survey: TEST_SURVEY })

		expect(ctx.logBuffer).toHaveLength(1)
		const record = ctx.logBuffer[0]
		expect(record.eventName).toBe("survey_shown")

		const attrMap = attrs(record)
		expect(attrMap.survey_id).toBe(TEST_SURVEY.id)
		expect(attrMap["session.id"]).toBe(ctx.sessionId)
		expect(attrMap.client).toBe("pi")
		expect(attrMap.source).toBe("cli")

		await ctx.drain()
	})

	it("emits survey_answered with the abstract survey response fields", async () => {
		const ctx = new SessionContext(makeConfig(), "cli")

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

	it("does not emit survey_answered for an unknown answer id", async () => {
		const ctx = new SessionContext(makeConfig(), "cli")

		emitSurveyAnswered(ctx, { survey: TEST_SURVEY, submissionId: "submission-1", answerId: "unknown" })

		expect(ctx.logBuffer).toHaveLength(0)

		await ctx.drain()
	})

	it("emits survey_dismissed with the survey id", async () => {
		const ctx = new SessionContext(makeConfig(), "cli")

		emitSurveyDismissed(ctx, { survey: TEST_SURVEY })

		expect(ctx.logBuffer).toHaveLength(1)
		const record = ctx.logBuffer[0]
		expect(record.eventName).toBe("survey_dismissed")

		const attrMap = attrs(record)
		expect(attrMap.survey_id).toBe(TEST_SURVEY.id)

		await ctx.drain()
	})

	it("emits triggered survey events with the survey response fields", async () => {
		const ctx = new SessionContext(makeConfig(), "cli")

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
