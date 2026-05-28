import { afterEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../config.js"
import { SessionContext, _resetSharedAccumulators } from "./session-context.js"
import { emitSurveyAnswered, emitSurveyDismissed, emitSurveyShown } from "./survey.js"
import type { LogRecord } from "./transport.js"

vi.mock("../../api/me.js", () => ({
	getMe: vi.fn().mockResolvedValue({ id: "test-user", email: "test@example.com" }),
}))

const TEST_SURVEY = {
	id: "first-impression-feedback-v1",
	version: 1,
	question: {
		id: "how_did_that_go",
		text: "How did Kimchi do?",
		help: "Your feedback helps us improve.",
	},
	options: [
		{ id: "worked_great", label: "Went great - shipped it", score: 5 },
		{ id: "mostly_worked", label: "Mostly worked - some tweaks before merge", score: 3 },
		{ id: "didnt_work", label: "Didn't work - try again differently", score: 1 },
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

	it("emits survey_shown with the v1 survey context", async () => {
		const ctx = new SessionContext(makeConfig(), "cli", "coding")

		emitSurveyShown(ctx, { survey: TEST_SURVEY, impressionId: "impression-1" })

		expect(ctx.logBuffer).toHaveLength(1)
		const record = ctx.logBuffer[0]
		expect(record.eventName).toBe("survey_shown")

		const attrMap = attrs(record)
		expect(attrMap.impression_id).toBe("impression-1")
		expect(attrMap.survey_id).toBe(TEST_SURVEY.id)
		expect(attrMap.survey_version).toBe(String(TEST_SURVEY.version))
		expect(attrMap.question_id).toBe(TEST_SURVEY.question.id)
		expect(attrMap.question_text).toBe(TEST_SURVEY.question.text)
		expect(attrMap.question_help).toBe(TEST_SURVEY.question.help)
		expect(attrMap["session.id"]).toBe(ctx.sessionId)
		expect(attrMap.client).toBe("pi")
		expect(attrMap.source).toBe("cli")
		expect(attrMap.mode).toBe("coding")

		await ctx.drain()
	})

	it("emits survey_answered with answer metadata", async () => {
		const ctx = new SessionContext(makeConfig(), "cli", "coding")

		emitSurveyAnswered(ctx, { survey: TEST_SURVEY, impressionId: "impression-1", answerId: "mostly_worked" })

		expect(ctx.logBuffer).toHaveLength(1)
		const record = ctx.logBuffer[0]
		expect(record.eventName).toBe("survey_answered")

		const attrMap = attrs(record)
		expect(attrMap.impression_id).toBe("impression-1")
		expect(attrMap.answer_id).toBe("mostly_worked")
		expect(attrMap.answer_label).toBe("Mostly worked - some tweaks before merge")
		expect(attrMap.answer_score).toBe("3")

		await ctx.drain()
	})

	it("does not emit survey_answered for an unknown answer id", async () => {
		const ctx = new SessionContext(makeConfig(), "cli", "coding")

		emitSurveyAnswered(ctx, { survey: TEST_SURVEY, impressionId: "impression-1", answerId: "unknown" })

		expect(ctx.logBuffer).toHaveLength(0)

		await ctx.drain()
	})

	it("emits survey_dismissed with a dismiss reason", async () => {
		const ctx = new SessionContext(makeConfig(), "cli", "coding")

		emitSurveyDismissed(ctx, { survey: TEST_SURVEY, impressionId: "impression-1" })

		expect(ctx.logBuffer).toHaveLength(1)
		const record = ctx.logBuffer[0]
		expect(record.eventName).toBe("survey_dismissed")

		const attrMap = attrs(record)
		expect(attrMap.impression_id).toBe("impression-1")
		expect(attrMap.dismiss_reason).toBe("dismissed")
		expect(attrMap.question_id).toBe(TEST_SURVEY.question.id)
		expect(attrMap.question_text).toBe(TEST_SURVEY.question.text)

		await ctx.drain()
	})

	it("emits survey events with trigger metadata and a shared impression id", async () => {
		const ctx = new SessionContext(makeConfig(), "cli", "ferment")

		emitSurveyShown(ctx, { survey: TEST_SURVEY, impressionId: "impression-1", trigger: "ferment_completed" })
		emitSurveyAnswered(ctx, {
			survey: TEST_SURVEY,
			impressionId: "impression-1",
			answerId: "worked_great",
			trigger: "ferment_completed",
		})
		emitSurveyDismissed(ctx, {
			survey: TEST_SURVEY,
			impressionId: "impression-1",
			trigger: "ferment_completed",
			reason: "ctrl_c",
		})

		expect(attrs(ctx.logBuffer[0]).trigger).toBe("ferment_completed")
		expect(attrs(ctx.logBuffer[1]).trigger).toBe("ferment_completed")
		expect(attrs(ctx.logBuffer[2]).dismiss_reason).toBe("ctrl_c")
		expect(attrs(ctx.logBuffer[0]).impression_id).toBe("impression-1")
		expect(attrs(ctx.logBuffer[1]).impression_id).toBe("impression-1")
		expect(attrs(ctx.logBuffer[2]).impression_id).toBe("impression-1")

		await ctx.drain()
	})
})
