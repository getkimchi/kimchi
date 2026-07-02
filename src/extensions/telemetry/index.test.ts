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
	// pi.events: a minimal EventBus stub so the telemetry extension can
	// subscribe to ferment domain events without throwing.
	const eventBusListeners = new Map<string, ((data: unknown) => void)[]>()
	const events = {
		emit: (channel: string, data: unknown) => {
			for (const fn of eventBusListeners.get(channel) ?? []) fn(data)
		},
		on: (channel: string, handler: (data: unknown) => void) => {
			if (!eventBusListeners.has(channel)) eventBusListeners.set(channel, [])
			;(eventBusListeners.get(channel) as ((d: unknown) => void)[]).push(handler)
			return () => {}
		},
	}
	return { on, handlers, events, api: { on, events } as unknown as ExtensionAPI }
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

	it("turn_start event updates ctx.turnIndex", async () => {
		const { handlers, api } = createMockApi()
		telemetryExtension(makeConfig())(api)
		await getHandler(handlers, "session_start")({}, { model: { id: "claude-opus-4-6" } })

		await getHandler(handlers, "turn_start")({ turnIndex: 3 })

		const { default: _ext, ...rest } = await import("./index.js")
		// Verify via before_provider_headers which exposes ctx.turnIndex
		const result = getHandler(handlers, "before_provider_headers")({ headers: {} })
		expect((result as unknown as Record<string, string>)["X-Turn-Index"]).toBe("3")
	})

	it("before_provider_headers injects X-Session-Id and X-Turn-Index", async () => {
		const { handlers, api } = createMockApi()
		telemetryExtension(makeConfig())(api)
		await getHandler(handlers, "session_start")({}, { model: { id: "claude-opus-4-6" } })

		// Set a known turn index via the turn_start handler
		await getHandler(handlers, "turn_start")({ turnIndex: 4 })

		const result = getHandler(handlers, "before_provider_headers")({ headers: { "User-Agent": "kimchi/1.0" } })
		const headers = result as unknown as Record<string, string>

		expect(headers["User-Agent"]).toBe("kimchi/1.0")
		expect(typeof headers["X-Session-Id"]).toBe("string")
		expect(headers["X-Session-Id"]).toMatch(/^[0-9a-f-]{36}$/)
		expect(headers["X-Turn-Index"]).toBe("4")
	})
})

// ---------------------------------------------------------------------------
// Ferment domain event → OTLP log record tests
// ---------------------------------------------------------------------------

describe("ferment lifecycle telemetry via pi.events", () => {
	let fetchMock: ReturnType<typeof vi.fn>
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" })
		originalFetch = globalThis.fetch
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		globalThis.fetch = fetchMock as any
	})

	afterEach(async () => {
		globalThis.fetch = originalFetch
		_resetSharedAccumulators()
		const { _resetFermentTrackingState } = await import("./index.js")
		_resetFermentTrackingState()
		vi.restoreAllMocks()
	})

	async function setup() {
		const { handlers, events, api } = createMockApi()
		const { default: ext } = await import("./index.js")
		ext(makeConfig())(api)
		await getHandler(handlers, "session_start")({}, { model: { id: "claude-sonnet-4-6" } })
		return { handlers, events }
	}

	function extractRecords() {
		const logCalls = fetchMock.mock.calls.filter(([url]: unknown[]) => String(url).includes("/logs"))
		return logCalls.flatMap(([, opts]: unknown[]) => {
			const body = JSON.parse((opts as { body: string }).body)
			return body.resourceLogs[0].scopeLogs[0].logRecords as Array<{
				eventName: string
				attributes: Array<{ key: string; value: { stringValue: string } }>
			}>
		})
	}

	function attrsOf(rec: { attributes: Array<{ key: string; value: { stringValue: string } }> }) {
		return Object.fromEntries(rec.attributes.map((a) => [a.key, a.value.stringValue]))
	}

	it("ferment:started → ferment.started OTLP record with ferment_id, name, model", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		events.emit(FERMENT_EVENTS.STARTED, { fermentId: "f-001", name: "My Ferment", phaseCount: 3 })
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.started")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(attrs.ferment_id).toBe("f-001")
		expect(attrs.ferment_name).toBe("My Ferment")
		expect(attrs.phase_count).toBe("3")
		expect(attrs.model).toBe("claude-sonnet-4-6")
		expect(attrs["session.id"]).toBeDefined()
	})

	it("ferment:completed → ferment.completed with grade and steering_count", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		// Seed start time so duration is non-zero
		events.emit(FERMENT_EVENTS.STARTED, { fermentId: "f-002", name: "Done", phaseCount: 2 })
		events.emit(FERMENT_EVENTS.STEERING, { fermentId: "f-002" })
		events.emit(FERMENT_EVENTS.STEERING, { fermentId: "f-002" })
		events.emit(FERMENT_EVENTS.COMPLETED, {
			fermentId: "f-002",
			name: "Done",
			grade: "A",
			phaseCount: 2,
			blockRetries: 1,
			durationMs: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			steeringCount: 0,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.completed")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(attrs.ferment_id).toBe("f-002")
		expect(attrs.grade).toBe("A")
		expect(attrs.steering_count).toBe("2")
		expect(attrs.block_retries).toBe("1")
		expect(attrs.model).toBe("claude-sonnet-4-6")
	})

	it("ferment:completed without grade omits grade attr", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		events.emit(FERMENT_EVENTS.COMPLETED, {
			fermentId: "f-003",
			name: "No Grade",
			phaseCount: 1,
			blockRetries: 0,
			durationMs: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			steeringCount: 0,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.completed")
		expect(rec).toBeDefined()
		expect((rec as NonNullable<typeof rec>).attributes.map((a) => a.key)).not.toContain("grade")
	})

	it("ferment:abandoned → ferment.abandoned with all new diagnostic fields", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		// Emit a steering event first so steering_count is tracked.
		events.emit(FERMENT_EVENTS.STARTED, { fermentId: "f-004", name: "Aborted", phaseCount: 3 })
		events.emit(FERMENT_EVENTS.STEERING, { fermentId: "f-004" })
		events.emit(FERMENT_EVENTS.STEERING, { fermentId: "f-004" })
		events.emit(FERMENT_EVENTS.ABANDONED, {
			fermentId: "f-004",
			name: "Aborted",
			reason: "judge failed",
			lifecycleStage: "running",
			scopingComplete: true,
			completedPhases: 1,
			totalPhases: 3,
			phaseCompletionRatio: 1 / 3,
			lastActivePhaseIndex: 2,
			stepFailureCount: 1,
			durationMs: 12345,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.abandoned")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(attrs.ferment_id).toBe("f-004")
		expect(attrs.reason).toBe("judge failed")
		expect(attrs.model).toBe("claude-sonnet-4-6")
		// New diagnostic fields
		expect(attrs.lifecycle_stage).toBe("running")
		expect(attrs.scoping_complete).toBe("true")
		expect(attrs.completed_phases).toBe("1")
		expect(attrs.total_phases).toBe("3")
		expect(Number(attrs.phase_completion_ratio)).toBeCloseTo(1 / 3)
		expect(attrs.last_active_phase_index).toBe("2")
		expect(attrs.step_failure_count).toBe("1")
		expect(attrs.duration_ms).toBe("12345")
		expect(attrs.steering_count).toBe("2")
	})

	it("ferment:abandoned → ferment.abandoned omits last_active_phase_index when undefined", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		events.emit(FERMENT_EVENTS.ABANDONED, {
			fermentId: "f-004b",
			name: "Draft Aborted",
			lifecycleStage: "draft",
			scopingComplete: false,
			completedPhases: 0,
			totalPhases: 0,
			phaseCompletionRatio: 0,
			lastActivePhaseIndex: undefined,
			stepFailureCount: 0,
			durationMs: 500,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.abandoned")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(attrs.lifecycle_stage).toBe("draft")
		expect(attrs.scoping_complete).toBe("false")
		expect(attrs.completed_phases).toBe("0")
		expect(attrs.total_phases).toBe("0")
		expect(attrs.phase_completion_ratio).toBe("0")
		expect(attrs.duration_ms).toBe("500")
		expect(attrs.steering_count).toBe("0")
		// Optional field must be absent when undefined
		expect((rec as NonNullable<typeof rec>).attributes.map((a) => a.key)).not.toContain("last_active_phase_index")
	})

	it("ferment:stalled → ferment.stalled event emitted for Leave paused path", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		events.emit(FERMENT_EVENTS.STALLED, {
			fermentId: "f-stall-1",
			name: "Stalled Ferment",
			lifecycleStage: "paused",
			idleDurationMs: 86400000, // 24 hours
			completedPhases: 2,
			totalPhases: 4,
			phaseCompletionRatio: 0.5,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.stalled")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(attrs.ferment_id).toBe("f-stall-1")
		expect(attrs.ferment_name).toBe("Stalled Ferment")
		expect(attrs.lifecycle_stage).toBe("paused")
		expect(attrs.idle_duration_ms).toBe("86400000")
		expect(attrs.completed_phases).toBe("2")
		expect(attrs.total_phases).toBe("4")
		expect(attrs.phase_completion_ratio).toBe("0.5")
		expect(attrs.model).toBe("claude-sonnet-4-6")
	})

	it("ferment:stalled → ferment.stalled event emitted for crash-recovery path", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		events.emit(FERMENT_EVENTS.STALLED, {
			fermentId: "f-stall-crash",
			name: "Crashed Ferment",
			lifecycleStage: "running",
			idleDurationMs: 3600000, // 1 hour
			completedPhases: 0,
			totalPhases: 2,
			phaseCompletionRatio: 0,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.stalled")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(attrs.ferment_id).toBe("f-stall-crash")
		expect(attrs.ferment_name).toBe("Crashed Ferment")
		expect(attrs.lifecycle_stage).toBe("running")
		expect(attrs.idle_duration_ms).toBe("3600000")
		expect(attrs.completed_phases).toBe("0")
		expect(attrs.total_phases).toBe("2")
		expect(attrs.phase_completion_ratio).toBe("0")
	})

	it("ferment:phase_started → ferment.phase.started with phase_id", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		events.emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: "f-005",
			phaseId: "ph-1",
			phaseIndex: 1,
			phaseName: "Build",
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.phase.started")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(attrs.ferment_id).toBe("f-005")
		expect(attrs.phase_id).toBe("ph-1")
		expect(attrs.phase_name).toBe("Build")
		expect(attrs["session.id"]).toBeDefined()
	})

	it("ferment:phase_completed → ferment.phase.completed with grade and delta tokens", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		events.emit(FERMENT_EVENTS.PHASE_COMPLETED, {
			fermentId: "f-006",
			phaseId: "ph-2",
			phaseIndex: 2,
			phaseName: "Test",
			grade: "B",
			durationMs: 12000,
			deltaInputTokens: 0,
			deltaOutputTokens: 0,
			blockRetries: 2,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.phase.completed")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(attrs.ferment_id).toBe("f-006")
		expect(attrs.phase_id).toBe("ph-2")
		expect(attrs.grade).toBe("B")
		expect(attrs.block_retries).toBe("2")
	})

	it("ferment:step_started → ferment.step.started with step_id, records start time", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		events.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "f-007", phaseId: "ph-1", stepId: "step-1", stepIndex: 1 })
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.step.started")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(attrs.ferment_id).toBe("f-007")
		expect(attrs.phase_id).toBe("ph-1")
		expect(attrs.step_id).toBe("step-1")
		expect(attrs["session.id"]).toBeDefined()
	})

	it("ferment:step_completed → ferment.step.completed with duration and success", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		events.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "f-008", phaseId: "ph-1", stepId: "step-2", stepIndex: 2 })
		events.emit(FERMENT_EVENTS.STEP_COMPLETED, {
			fermentId: "f-008",
			phaseId: "ph-1",
			stepId: "step-2",
			stepIndex: 2,
			durationMs: 0,
			grade: "A",
			success: true,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.step.completed")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(attrs.ferment_id).toBe("f-008")
		expect(attrs.step_id).toBe("step-2")
		expect(attrs.grade).toBe("A")
		expect(attrs.success).toBe("true")
		expect(Number(attrs.duration_ms)).toBeGreaterThanOrEqual(0)
	})

	it("ferment:step_started → ferment:step_completed uses composite key; parallel phases don't collide", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		// Two phases, each with step-1 — should not overwrite each other's start time
		events.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "f-009", phaseId: "ph-A", stepId: "step-1", stepIndex: 1 })
		events.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "f-009", phaseId: "ph-B", stepId: "step-1", stepIndex: 1 })
		events.emit(FERMENT_EVENTS.STEP_COMPLETED, {
			fermentId: "f-009",
			phaseId: "ph-A",
			stepId: "step-1",
			stepIndex: 1,
			durationMs: 0,
			success: true,
		})
		events.emit(FERMENT_EVENTS.STEP_COMPLETED, {
			fermentId: "f-009",
			phaseId: "ph-B",
			stepId: "step-1",
			stepIndex: 1,
			durationMs: 0,
			success: true,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const completions = extractRecords().filter((r) => r.eventName === "ferment.step.completed")
		expect(completions).toHaveLength(2)
		const phaseIds = completions.map((r) => attrsOf(r).phase_id)
		expect(phaseIds).toContain("ph-A")
		expect(phaseIds).toContain("ph-B")
	})

	it("ferment:step_failed → ferment.step.failed with reason, clears start time", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		events.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "f-010", phaseId: "ph-1", stepId: "step-3", stepIndex: 3 })
		events.emit(FERMENT_EVENTS.STEP_FAILED, {
			fermentId: "f-010",
			phaseId: "ph-1",
			stepId: "step-3",
			stepIndex: 3,
			reason: "tests failed",
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.step.failed")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(attrs.ferment_id).toBe("f-010")
		expect(attrs.step_id).toBe("step-3")
		expect(attrs.reason).toBe("tests failed")
	})

	it("ferment:step_started re-emitted after step_failed records new start time (retry path)", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")
		const { _resetFermentTrackingState } = await import("./index.js")

		// Simulate: start → fail → retry start → complete
		events.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "f-011", phaseId: "ph-1", stepId: "step-1", stepIndex: 1 })
		events.emit(FERMENT_EVENTS.STEP_FAILED, { fermentId: "f-011", phaseId: "ph-1", stepId: "step-1", stepIndex: 1 })
		events.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "f-011", phaseId: "ph-1", stepId: "step-1", stepIndex: 1 })
		events.emit(FERMENT_EVENTS.STEP_COMPLETED, {
			fermentId: "f-011",
			phaseId: "ph-1",
			stepId: "step-1",
			stepIndex: 1,
			durationMs: 0,
			success: true,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const startEvents = extractRecords().filter((r) => r.eventName === "ferment.step.started")
		const completedEvents = extractRecords().filter((r) => r.eventName === "ferment.step.completed")
		// Two starts (initial + retry), one completion — lifecycle is balanced
		expect(startEvents).toHaveLength(2)
		expect(completedEvents).toHaveLength(1)
		expect(attrsOf(completedEvents[0] as NonNullable<(typeof completedEvents)[0]>).success).toBe("true")
	})

	it("all events are no-ops when telemetry is disabled", async () => {
		const { handlers, events, api } = createMockApi()
		const { default: ext, _resetFermentTrackingState } = await import("./index.js")
		ext(makeConfig({ enabled: false }))(api)
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		events.emit(FERMENT_EVENTS.STARTED, { fermentId: "f-x", name: "X", phaseCount: 1 })
		events.emit(FERMENT_EVENTS.COMPLETED, {
			fermentId: "f-x",
			name: "X",
			phaseCount: 1,
			blockRetries: 0,
			durationMs: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			steeringCount: 0,
		})
		events.emit(FERMENT_EVENTS.STEERING, { fermentId: "f-x" })

		if (handlers.has("session_shutdown")) await getHandler(handlers, "session_shutdown")({ reason: "test" })
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("ferment events carry explicit ferment_id even when no active ferment", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")
		const { getActiveFerment } = await import("../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue(undefined)

		events.emit(FERMENT_EVENTS.COMPLETED, {
			fermentId: "f-explicit",
			name: "Explicit ID Test",
			grade: "B",
			phaseCount: 1,
			blockRetries: 0,
			durationMs: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			steeringCount: 0,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.completed")
		expect(rec).toBeDefined()
		expect(attrsOf(rec as NonNullable<typeof rec>).ferment_id).toBe("f-explicit")
	})
})

describe("edge case coverage", () => {
	let fetchMock: ReturnType<typeof vi.fn>
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" })
		originalFetch = globalThis.fetch
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		globalThis.fetch = fetchMock as any
	})

	afterEach(async () => {
		globalThis.fetch = originalFetch
		_resetSharedAccumulators()
		const { _resetFermentTrackingState } = await import("./index.js")
		_resetFermentTrackingState()
		vi.restoreAllMocks()
	})

	async function setup() {
		const { handlers, events, api } = createMockApi()
		const { default: ext } = await import("./index.js")
		ext(makeConfig())(api)
		await getHandler(handlers, "session_start")({}, { model: { id: "claude-sonnet-4-6" } })
		return { handlers, events }
	}

	function extractRecords() {
		const logCalls = fetchMock.mock.calls.filter(([url]: unknown[]) => String(url).includes("/logs"))
		return logCalls.flatMap(([, opts]: unknown[]) => {
			const body = JSON.parse((opts as { body: string }).body)
			return body.resourceLogs[0].scopeLogs[0].logRecords as Array<{
				eventName: string
				attributes: Array<{ key: string; value: { stringValue: string } }>
			}>
		})
	}

	function attrsOf(rec: { attributes: Array<{ key: string; value: { stringValue: string } }> }) {
		return Object.fromEntries(rec.attributes.map((a) => [a.key, a.value.stringValue]))
	}

	it("phase duration_ms is computed from phase start time, not payload", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		events.emit(FERMENT_EVENTS.PHASE_STARTED, { fermentId: "f-d", phaseId: "ph-1", phaseIndex: 1, phaseName: "Build" })
		// Small delay to ensure duration > 0
		await new Promise((r) => setTimeout(r, 10))
		events.emit(FERMENT_EVENTS.PHASE_COMPLETED, {
			fermentId: "f-d",
			phaseId: "ph-1",
			phaseIndex: 1,
			phaseName: "Build",
			durationMs: 0,
			deltaInputTokens: 0,
			deltaOutputTokens: 0,
			blockRetries: 0,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.phase.completed")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(Number(attrs.duration_ms)).toBeGreaterThan(0)
	})

	it("skip_phase emits ferment.phase.completed", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		events.emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: "f-s",
			phaseId: "ph-skip",
			phaseIndex: 1,
			phaseName: "Skipped",
		})
		events.emit(FERMENT_EVENTS.PHASE_COMPLETED, {
			fermentId: "f-s",
			phaseId: "ph-skip",
			phaseIndex: 1,
			phaseName: "Skipped",
			durationMs: 0,
			deltaInputTokens: 0,
			deltaOutputTokens: 0,
			blockRetries: 0,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.phase.completed")
		expect(rec).toBeDefined()
		expect(attrsOf(rec as NonNullable<typeof rec>).phase_id).toBe("ph-skip")
	})

	it("skip_step emits ferment.step.completed with success=true", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		events.emit(FERMENT_EVENTS.STEP_COMPLETED, {
			fermentId: "f-ss",
			phaseId: "ph-1",
			stepId: "step-skip",
			stepIndex: 1,
			durationMs: 0,
			success: true,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.step.completed")
		expect(rec).toBeDefined()
		expect(attrsOf(rec as NonNullable<typeof rec>).success).toBe("true")
	})

	it("ferment.phase.completed includes steering_count for steerings during that phase", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		// Steering before the phase starts — must not be counted in the phase.
		events.emit(FERMENT_EVENTS.STEERING, { fermentId: "f-steer-phase" })

		events.emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: "f-steer-phase",
			phaseId: "ph-1",
			phaseIndex: 1,
			phaseName: "Build",
		})
		// Two steerings during the phase.
		events.emit(FERMENT_EVENTS.STEERING, { fermentId: "f-steer-phase" })
		events.emit(FERMENT_EVENTS.STEERING, { fermentId: "f-steer-phase" })
		events.emit(FERMENT_EVENTS.PHASE_COMPLETED, {
			fermentId: "f-steer-phase",
			phaseId: "ph-1",
			phaseIndex: 1,
			phaseName: "Build",
			durationMs: 0,
			deltaInputTokens: 0,
			deltaOutputTokens: 0,
			blockRetries: 0,
			steeringCount: 0,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.phase.completed")
		expect(rec).toBeDefined()
		expect(attrsOf(rec as NonNullable<typeof rec>).steering_count).toBe("2")
	})

	it("ferment.step.completed includes steering_count for steerings during that step", async () => {
		const { handlers, events } = await setup()
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		// Steering before the step starts — must not be counted in the step.
		events.emit(FERMENT_EVENTS.STEERING, { fermentId: "f-steer-step" })

		events.emit(FERMENT_EVENTS.STEP_STARTED, {
			fermentId: "f-steer-step",
			phaseId: "ph-1",
			stepId: "step-1",
			stepIndex: 1,
		})
		// One steering during the step.
		events.emit(FERMENT_EVENTS.STEERING, { fermentId: "f-steer-step" })
		events.emit(FERMENT_EVENTS.STEP_COMPLETED, {
			fermentId: "f-steer-step",
			phaseId: "ph-1",
			stepId: "step-1",
			stepIndex: 1,
			durationMs: 0,
			success: true,
			steeringCount: 0,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "ferment.step.completed")
		expect(rec).toBeDefined()
		expect(attrsOf(rec as NonNullable<typeof rec>).steering_count).toBe("1")
	})
})

describe("token accounting regression tests", () => {
	let fetchMock: ReturnType<typeof vi.fn>
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" })
		originalFetch = globalThis.fetch
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		globalThis.fetch = fetchMock as any
	})

	afterEach(async () => {
		globalThis.fetch = originalFetch
		_resetSharedAccumulators()
		const { _resetFermentTrackingState } = await import("./index.js")
		_resetFermentTrackingState()
		vi.restoreAllMocks()
	})

	it("ferment.completed carries non-zero token totals summed from phase deltas", async () => {
		// Totals on ferment.completed come from summing phase deltas, not from
		// diffing the session accumulator. This avoids counting scoping-conversation
		// tokens that accumulated before phases started.
		const { handlers, events, api } = createMockApi()
		const { default: ext, _resetFermentTrackingState } = await import("./index.js")
		ext(makeConfig())(api)
		await getHandler(handlers, "session_start")({}, { model: { id: "claude-sonnet-4-6" } })

		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")

		// 1. Ferment + phase start
		events.emit(FERMENT_EVENTS.STARTED, { fermentId: "f-tokens", name: "Token Test", phaseCount: 1 })
		events.emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: "f-tokens",
			phaseId: "phase-1",
			phaseIndex: 0,
			phaseName: "Phase 1",
		})

		// 2. Simulate a message_end with usage (this populates the session accumulator)
		await getHandler(
			handlers,
			"message_end",
		)({
			message: {
				role: "assistant",
				model: "claude-sonnet-4-6",
				provider: "anthropic",
				timestamp: Date.now(),
				usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } },
			},
		})

		// 3. Phase completes — delta is computed (500 input, 200 output, 0.05 cost)
		events.emit(FERMENT_EVENTS.PHASE_COMPLETED, {
			fermentId: "f-tokens",
			phaseId: "phase-1",
			phaseIndex: 0,
			phaseName: "Phase 1",
			blockRetries: 0,
		})

		// 4. Ferment completes — totals should reflect the summed phase deltas
		events.emit(FERMENT_EVENTS.COMPLETED, {
			fermentId: "f-tokens",
			name: "Token Test",
			phaseCount: 1,
			blockRetries: 0,
			durationMs: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			steeringCount: 0,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const logCalls = fetchMock.mock.calls.filter(([url]: unknown[]) => String(url).includes("/logs"))
		const allRecords = logCalls.flatMap(([, opts]: unknown[]) => {
			const body = JSON.parse((opts as { body: string }).body)
			return body.resourceLogs[0].scopeLogs[0].logRecords as Array<{
				eventName: string
				attributes: Array<{ key: string; value: { stringValue: string } }>
			}>
		})
		const rec = allRecords.find((r) => r.eventName === "ferment.completed")
		expect(rec).toBeDefined()
		const attrs = Object.fromEntries(
			(rec as NonNullable<typeof rec>).attributes.map((a) => [a.key, a.value.stringValue]),
		)
		// Totals = sum of phase-1 delta (500 input, 200 output, 0.05 cost)
		expect(Number(attrs.total_input_tokens)).toBe(500)
		expect(Number(attrs.total_output_tokens)).toBe(200)
	})

	it("ferment.started is emitted with session_type ferment (active ferment set before emit)", async () => {
		// Regression: emitFermentCreated was called before setActiveFermentAndApplyProfile,
		// so session_type was "coding" instead of "ferment".
		const { handlers, events, api } = createMockApi()
		const { default: ext } = await import("./index.js")
		ext(makeConfig())(api)

		// Simulate active ferment being set BEFORE the event fires (as fixed in commands.ts)
		const { getActiveFerment } = await import("../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue({ id: "f-stype" } as never)

		await getHandler(handlers, "session_start")({}, { model: { id: "claude-sonnet-4-6" } })
		const { FERMENT_EVENTS } = await import("../ferment/domain-events.js")
		events.emit(FERMENT_EVENTS.STARTED, { fermentId: "f-stype", name: "Session Type", phaseCount: 1 })
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const logCalls = fetchMock.mock.calls.filter(([url]: unknown[]) => String(url).includes("/logs"))
		const allRecords = logCalls.flatMap(([, opts]: unknown[]) => {
			const body = JSON.parse((opts as { body: string }).body)
			return body.resourceLogs[0].scopeLogs[0].logRecords as Array<{
				eventName: string
				attributes: Array<{ key: string; value: { stringValue: string } }>
			}>
		})
		const rec = allRecords.find((r) => r.eventName === "ferment.started")
		expect(rec).toBeDefined()
		const attrs = Object.fromEntries(
			(rec as NonNullable<typeof rec>).attributes.map((a) => [a.key, a.value.stringValue]),
		)
		expect(attrs.session_type).toBe("ferment")
	})
})

// ---------------------------------------------------------------------------
// Bash-tool-guard domain event → OTLP log record tests
// ---------------------------------------------------------------------------

describe("bash-tool-guard telemetry via pi.events", () => {
	let fetchMock: ReturnType<typeof vi.fn>
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" })
		originalFetch = globalThis.fetch
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		globalThis.fetch = fetchMock as any
	})

	afterEach(async () => {
		globalThis.fetch = originalFetch
		_resetSharedAccumulators()
		const { _resetFermentTrackingState, _getBashGuardCounts } = await import("./index.js")
		_resetFermentTrackingState()
		// Reset bash-guard counters by emitting zeros via the reset hook
		// (the counters reset on session_start; calling it clears state).
		vi.restoreAllMocks()
		// Force fresh state for next test by clearing module-level accumulators.
		// Direct access is not exposed; reset via the public reset path.
		expect(_getBashGuardCounts()).toBeDefined()
	})

	async function setup() {
		const { handlers, events, api } = createMockApi()
		const { default: ext } = await import("./index.js")
		ext(makeConfig())(api)
		await getHandler(handlers, "session_start")({}, { model: { id: "claude-sonnet-4-6" } })
		return { handlers, events }
	}

	function extractRecords() {
		const logCalls = fetchMock.mock.calls.filter(([url]: unknown[]) => String(url).includes("/logs"))
		return logCalls.flatMap(([, opts]: unknown[]) => {
			const body = JSON.parse((opts as { body: string }).body)
			return body.resourceLogs[0].scopeLogs[0].logRecords as Array<{
				eventName: string
				attributes: Array<{ key: string; value: { stringValue: string } }>
			}>
		})
	}

	function attrsOf(rec: { attributes: Array<{ key: string; value: { stringValue: string } }> }) {
		return Object.fromEntries(rec.attributes.map((a) => [a.key, a.value.stringValue]))
	}

	it("bash_tool_guard:warn → bash_tool_guard.warn OTLP record with category, tool, count", async () => {
		const { handlers, events } = await setup()
		const { BASH_TOOL_GUARD_EVENTS } = await import("../bash-tool-guard-events.js")

		events.emit(BASH_TOOL_GUARD_EVENTS.WARN, {
			category: "read",
			tool: "cat",
			count: 1,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "bash_tool_guard.warn")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(attrs.category).toBe("read")
		expect(attrs.tool).toBe("cat")
		expect(attrs.count).toBe("1")
		// Raw command text must not leak into OTLP — only structured fields.
		expect(attrs.segment_preview).toBeUndefined()
		expect(attrs.matchedSegment).toBeUndefined()
		expect(attrs.model).toBe("claude-sonnet-4-6")
	})

	it("bash_tool_guard:block → bash_tool_guard.block OTLP record with tool", async () => {
		const { handlers, events } = await setup()
		const { BASH_TOOL_GUARD_EVENTS } = await import("../bash-tool-guard-events.js")

		events.emit(BASH_TOOL_GUARD_EVENTS.BLOCK, {
			category: "edit",
			tool: "sed",
			count: 2,
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "bash_tool_guard.block")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(attrs.category).toBe("edit")
		expect(attrs.tool).toBe("sed")
		expect(attrs.count).toBe("2")
		// Raw command text must not leak into OTLP — only structured fields.
		expect(attrs.segment_preview).toBeUndefined()
		expect(attrs.matchedSegment).toBeUndefined()
	})

	it("bash_tool_guard:allowed_by_user_request → OTLP record with tool", async () => {
		const { handlers, events } = await setup()
		const { BASH_TOOL_GUARD_EVENTS } = await import("../bash-tool-guard-events.js")

		events.emit(BASH_TOOL_GUARD_EVENTS.ALLOWED_BY_USER_REQUEST, {
			category: "read",
			tool: "cat",
		})
		await getHandler(handlers, "session_shutdown")({ reason: "test" })

		const rec = extractRecords().find((r) => r.eventName === "bash_tool_guard.allowed_by_user_request")
		expect(rec).toBeDefined()
		const attrs = attrsOf(rec as NonNullable<typeof rec>)
		expect(attrs.category).toBe("read")
		expect(attrs.tool).toBe("cat")
	})

	it("does NOT emit OTLP records when telemetry is disabled", async () => {
		const { handlers, events } = createMockApi()
		const { default: ext } = await import("./index.js")
		ext(makeConfig({ enabled: false }))(handlers as unknown as ExtensionAPI)
		// Telemetry disabled → no OTLP fetch should occur when events fire.
		const { BASH_TOOL_GUARD_EVENTS } = await import("../bash-tool-guard-events.js")
		// Subscribers are NOT registered when config.enabled is false, so
		// emit() simply has no listeners and nothing reaches the network.
		events.emit(BASH_TOOL_GUARD_EVENTS.WARN, {
			category: "read",
			tool: "cat",
			count: 1,
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
