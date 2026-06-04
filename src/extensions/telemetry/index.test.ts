import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../config.js"
import telemetryExtension, {
	trackSubagentSpawned,
	trackSurveyAnswered,
	trackSurveyDismissed,
	trackSurveyShown,
} from "./index.js"
import { _resetSharedAccumulators } from "./session-context.js"

vi.mock("../ferment/index.js", () => ({
	getActiveFerment: vi.fn(() => undefined),
}))

vi.mock("../../startup-context.js", () => ({
	getAvailableModels: vi.fn(() => []),
}))

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

type Handler = (...args: unknown[]) => Promise<void> | void

function createMockApi() {
	const handlers = new Map<string, Handler[]>()
	const on = vi.fn((event: string, handler: Handler) => {
		if (!handlers.has(event)) handlers.set(event, [])
		handlers.get(event)?.push(handler)
	})
	return { on, handlers, api: { on } as unknown as ExtensionAPI }
}

function getHandler(handlers: Map<string, Handler[]>, event: string): Handler {
	const list = handlers.get(event)
	if (!list || list.length === 0) throw new Error(`No handler for ${event}`)
	return list[0]
}

function makeConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
	return {
		enabled: true,
		endpoint: "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest",
		metricsEndpoint: "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
		headers: { Authorization: "Bearer test-key" },
		apiKey: "",
		...overrides,
	}
}

describe("telemetryExtension integration", () => {
	let fetchMock: ReturnType<typeof vi.fn>
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" })
		originalFetch = globalThis.fetch
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		globalThis.fetch = fetchMock as any
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		_resetSharedAccumulators()
	})

	it("registers all expected event handlers when enabled", () => {
		const { handlers, api } = createMockApi()
		telemetryExtension(makeConfig())(api)
		expect(handlers.has("session_start")).toBe(true)
		expect(handlers.has("session_shutdown")).toBe(true)
		expect(handlers.has("message_start")).toBe(true)
		expect(handlers.has("message_end")).toBe(true)
		expect(handlers.has("tool_execution_start")).toBe(true)
		expect(handlers.has("tool_execution_end")).toBe(true)
		expect(handlers.has("before_agent_start")).toBe(true)
		expect(handlers.has("agent_end")).toBe(true)
	})

	it("registers no handlers when disabled", () => {
		const { handlers, api } = createMockApi()
		telemetryExtension(makeConfig({ enabled: false }))(api)
		expect(handlers.size).toBe(0)
	})

	it("full session lifecycle: start -> message -> tool -> shutdown", async () => {
		const { handlers, api } = createMockApi()
		telemetryExtension(makeConfig())(api)

		const mockExtCtx = { model: { id: "claude-opus-4-6" } }
		await getHandler(handlers, "session_start")({}, mockExtCtx)
		await getHandler(handlers, "before_agent_start")({ prompt: "hello" }, mockExtCtx)

		await getHandler(
			handlers,
			"message_end",
		)({
			message: {
				role: "assistant",
				model: "claude-opus-4-6",
				provider: "p",
				timestamp: Date.now(),
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
			},
		})

		getHandler(
			handlers,
			"tool_execution_start",
		)({ toolCallId: "t1", toolName: "edit", args: { path: "/tmp/a.ts", edits: [{ oldText: "a", newText: "b" }] } })
		await getHandler(handlers, "tool_execution_end")({ toolCallId: "t1", isError: false })

		await getHandler(handlers, "session_shutdown")({ reason: "user_exit" })

		const logCalls = fetchMock.mock.calls.filter(([url]: unknown[]) => String(url).includes("/logs"))
		const allRecords = logCalls.flatMap(([, opts]: unknown[]) => {
			const body = JSON.parse((opts as { body: string }).body)
			return body.resourceLogs[0].scopeLogs[0].logRecords as Array<{
				eventName: string
				attributes: Array<{ key: string; value: { stringValue: string } }>
			}>
		})
		const eventNames = allRecords.map((r) => r.eventName)
		expect(eventNames).toContain("session.start")
		expect(eventNames).toContain("user_message")
		expect(eventNames).toContain("api_request")
		expect(eventNames).toContain("tool_result")
		expect(eventNames).toContain("file_edited")
		expect(eventNames).toContain("session.end")

		for (const rec of allRecords) {
			const attrs = Object.fromEntries(rec.attributes.map((a) => [a.key, a.value.stringValue]))
			expect(attrs.model).toBe("claude-opus-4-6")
			expect(attrs.session_type).toBe("coding")
			expect(attrs.ferment_id).toBe("")
		}

		const metricsCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/metrics"))
		expect(metricsCalls.length).toBeGreaterThan(0)
	})

	it("trackSubagentSpawned sends kimchi.subagent.spawned with source and session_type", async () => {
		const { handlers, api } = createMockApi()
		telemetryExtension(makeConfig())(api)
		await getHandler(handlers, "session_start")({}, { model: { id: "claude-opus-4-6" } })
		await getHandler(handlers, "before_agent_start")({ prompt: "hello" }, { model: { id: "claude-opus-4-6" } })

		await trackSubagentSpawned({ id: "a1", type: "explore", description: "find files" })
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const logCalls = fetchMock.mock.calls.filter(([url]: unknown[]) => String(url).includes("/logs"))
		const allRecords = logCalls.flatMap(([, opts]: unknown[]) => {
			const body = JSON.parse((opts as { body: string }).body)
			return body.resourceLogs[0].scopeLogs[0].logRecords as Array<{
				eventName: string
				attributes: Array<{ key: string; value: { stringValue: string } }>
			}>
		})
		const subagentRecord = allRecords.find((rec) => rec.eventName === "subagent.spawned")
		expect(subagentRecord).toBeDefined()
		const attrs = Object.fromEntries(subagentRecord?.attributes.map((a) => [a.key, a.value.stringValue]) ?? [])
		expect(attrs.agent_type).toBe("explore")
		expect(attrs.reason).toBe("find files")
		expect(attrs.model).toBe("claude-opus-4-6")
		expect(attrs.source).toBe("cli")
		expect(attrs.session_type).toBe("coding")
		expect(attrs.ferment_id).toBe("")
	})

	it("survey tracking helpers send survey events through the telemetry batch", async () => {
		const { handlers, api } = createMockApi()
		telemetryExtension(makeConfig())(api)

		const submissionId = "submission-1"
		trackSurveyShown({ survey: TEST_SURVEY })
		trackSurveyAnswered({ survey: TEST_SURVEY, submissionId, answerId: "worked_great" })
		trackSurveyDismissed({ survey: TEST_SURVEY })
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const logCalls = fetchMock.mock.calls.filter(([url]: unknown[]) => String(url).includes("/logs"))
		const allRecords = logCalls.flatMap(([, opts]: unknown[]) => {
			const body = JSON.parse((opts as { body: string }).body)
			return body.resourceLogs[0].scopeLogs[0].logRecords as Array<{
				eventName: string
				attributes: Array<{ key: string; value: { stringValue: string } }>
			}>
		})

		const surveyShown = allRecords.find((rec) => rec.eventName === "survey_shown")
		const surveyAnswered = allRecords.find((rec) => rec.eventName === "survey_answered")
		const surveyDismissed = allRecords.find((rec) => rec.eventName === "survey_dismissed")

		expect(surveyShown).toBeDefined()
		expect(surveyAnswered).toBeDefined()
		expect(surveyDismissed).toBeDefined()

		const shownAttrs = Object.fromEntries(surveyShown?.attributes.map((a) => [a.key, a.value.stringValue]) ?? [])
		const answeredAttrs = Object.fromEntries(surveyAnswered?.attributes.map((a) => [a.key, a.value.stringValue]) ?? [])
		const dismissedAttrs = Object.fromEntries(
			surveyDismissed?.attributes.map((a) => [a.key, a.value.stringValue]) ?? [],
		)

		expect(shownAttrs.survey_id).toBe("019e87cc-5033-0000-d9bd-5e6501640b6e")
		expect(shownAttrs.client).toBe("pi")
		expect(shownAttrs.source).toBe("cli")

		expect(answeredAttrs.survey_id).toBe("019e87cc-5033-0000-d9bd-5e6501640b6e")
		expect(answeredAttrs.survey_submission_id).toBe(submissionId)
		expect(answeredAttrs.question_id).toBe("34f7caf5-7631-42f1-b6ed-d2a42ddde1cd")
		expect(answeredAttrs.answer_value).toBe("Went great")
		expect(answeredAttrs.survey_completed).toBe("true")

		expect(dismissedAttrs.survey_id).toBe("019e87cc-5033-0000-d9bd-5e6501640b6e")
	})
})
