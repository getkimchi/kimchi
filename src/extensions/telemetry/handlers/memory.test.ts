import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { logEvents } from "../otlp-test-utils.js"
import { TelemetryContext } from "../session-context.js"
import { handleMemoryTelemetry, MEMORY_TELEMETRY_RECORDS } from "./memory.js"

function makeConfig(): TelemetryConfig {
	return {
		enabled: true,
		endpoint: "http://localhost:4318/v1/logs",
		metricsEndpoint: "http://localhost:4318/v1/metrics",
		headers: {},
		apiKey: "",
	}
}

function wave() {
	return {
		event: "capture.wave",
		outcome: "completed",
		durationMs: 1_200,
		jobCount: 4,
		storedCount: 3,
		triagedWindowCount: 1,
		nonDurableCount: 1,
		valuationDiscardCount: 1,
		redactedCount: 1,
		oversizedCount: 0,
		failedJobCount: 0,
		addQuarantinedCount: 0,
		poisonQuarantinedCount: 0,
		pendingCount: 2,
		oldestPendingMs: 900,
	}
}

function recall() {
	return {
		event: "recall.completed",
		kind: "digest_progressive",
		trigger: "step_budget",
		outcome: "delivered",
		delivery: "steered",
		gateStatus: "passed",
		durationMs: 23,
		searchCount: 2,
		consideredCount: 8,
		selectedCount: 3,
		deliveredCount: 2,
		belowThresholdCount: 1,
		selectorSkippedCount: 1,
		overCapCount: 1,
		overBudgetCount: 0,
		estimatedTokens: 120,
	}
}

describe("memory telemetry handler", () => {
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	async function emitted(ctx: TelemetryContext, eventName: string) {
		ctx.flushLogBuffer()
		await vi.waitFor(() => {
			expect(
				logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).some((event) => event.eventName === eventName),
			).toBe(true)
		})
		return logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).find((event) => event.eventName === eventName)
	}

	it("emits initial session state and drops content-bearing extras", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleMemoryTelemetry(ctx, {
			event: "session_state",
			active: true,
			authoredEnabled: false,
			reason: "initial",
			fact: "canary fact",
			query: "canary query",
			project: "private/project",
		})
		const event = await emitted(ctx, MEMORY_TELEMETRY_RECORDS.SESSION_STATE)
		expect(event?.attrs).toMatchObject({
			active: "true",
			authored_enabled: "false",
			reason: "initial",
			turn_index: "0",
		})
		for (const key of ["fact", "query", "project", "fact_id", "path", "error"]) {
			expect(event?.attrs).not.toHaveProperty(key)
		}
		expect(JSON.stringify(event?.attrs)).not.toContain("canary")
		expect(JSON.stringify(event?.attrs)).not.toContain("private/project")
	})

	it("drops malformed state, spawn, and unknown events", async () => {
		const ctx = new TelemetryContext(makeConfig())
		for (const payload of [
			{ event: "session_state", active: "yes", authoredEnabled: true, reason: "initial" },
			{ event: "session_state", active: true, reason: "initial" },
			{ event: "capture.spawn", outcome: "unknown" },
			{ event: "future.event", outcome: "completed" },
			"not a payload",
			null,
		]) {
			handleMemoryTelemetry(ctx, payload)
		}
		ctx.flushLogBuffer()
		expect(logEvents(globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveLength(0)
	})

	it("emits capture scheduling and spawn outcomes", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleMemoryTelemetry(ctx, {
			event: "capture.schedule",
			outcome: "enqueued",
			messageCount: 30,
			pendingCount: 2,
			oldestPendingMs: 500,
		})
		handleMemoryTelemetry(ctx, { event: "capture.spawn", outcome: "started" })
		const schedule = await emitted(ctx, MEMORY_TELEMETRY_RECORDS.CAPTURE_SCHEDULE)
		expect(schedule?.attrs).toMatchObject({
			outcome: "enqueued",
			message_count: "30",
			pending_count: "2",
			oldest_pending_ms: "500",
		})
		const spawn = await emitted(ctx, MEMORY_TELEMETRY_RECORDS.CAPTURE_SPAWN)
		expect(spawn?.attrs.outcome).toBe("started")
	})

	it("emits the complete worker wave and fatal-failure summaries", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleMemoryTelemetry(ctx, wave())
		handleMemoryTelemetry(ctx, { event: "capture.failed", failureClass: "watchdog", durationMs: 42 })
		const event = await emitted(ctx, MEMORY_TELEMETRY_RECORDS.CAPTURE_WAVE)
		expect(event?.attrs).toMatchObject({
			outcome: "completed",
			duration_ms: "1200",
			job_count: "4",
			stored_count: "3",
			triaged_window_count: "1",
			non_durable_count: "1",
			valuation_discard_count: "1",
			redacted_count: "1",
			oversized_count: "0",
			failed_job_count: "0",
			add_quarantined_count: "0",
			poison_quarantined_count: "0",
			pending_count: "2",
			oldest_pending_ms: "900",
		})
		const failed = await emitted(ctx, MEMORY_TELEMETRY_RECORDS.CAPTURE_FAILED)
		expect(failed?.attrs).toMatchObject({ failure_class: "watchdog", duration_ms: "42" })
	})

	it("drops incomplete or invalid worker summaries", async () => {
		const ctx = new TelemetryContext(makeConfig())
		const { storedCount: _storedCount, ...incomplete } = wave()
		handleMemoryTelemetry(ctx, incomplete)
		handleMemoryTelemetry(ctx, { ...wave(), pendingCount: -1 })
		handleMemoryTelemetry(ctx, { event: "capture.failed", failureClass: "raw error text", durationMs: 42 })
		ctx.flushLogBuffer()
		expect(logEvents(globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveLength(0)
	})

	it("emits every recall field with the current turn and rejects sensitive extras", async () => {
		const ctx = new TelemetryContext(makeConfig())
		ctx.turnIndex = 7
		handleMemoryTelemetry(ctx, { ...recall(), query: "private prompt", selectedIds: ["fact-secret"] })
		const event = await emitted(ctx, MEMORY_TELEMETRY_RECORDS.RECALL_COMPLETED)
		expect(event?.attrs).toMatchObject({
			kind: "digest_progressive",
			trigger: "step_budget",
			outcome: "delivered",
			delivery: "steered",
			gate_status: "passed",
			duration_ms: "23",
			search_count: "2",
			considered_count: "8",
			selected_count: "3",
			delivered_count: "2",
			below_threshold_count: "1",
			selector_skipped_count: "1",
			over_cap_count: "1",
			over_budget_count: "0",
			estimated_tokens: "120",
			turn_index: "7",
		})
		expect(event?.attrs).not.toHaveProperty("query")
		expect(event?.attrs).not.toHaveProperty("selected_ids")
		expect(JSON.stringify(event?.attrs)).not.toContain("fact-secret")
	})

	it("drops invalid recall outcomes and numeric metadata", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleMemoryTelemetry(ctx, { ...recall(), outcome: "success" })
		handleMemoryTelemetry(ctx, { ...recall(), selectedCount: Number.NaN })
		ctx.flushLogBuffer()
		expect(logEvents(globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveLength(0)
	})

	it("emits search and save outcomes without sharing outcome vocabularies", async () => {
		const ctx = new TelemetryContext(makeConfig())
		for (const payload of [
			{
				event: "tool.completed",
				tool: "memory_search",
				outcome: "hits",
				durationMs: 5,
				retrievedCount: 8,
				returnedCount: 3,
			},
			{
				event: "tool.completed",
				tool: "save_memory",
				outcome: "duplicate",
				durationMs: 7,
				retrievedCount: 0,
				returnedCount: 0,
			},
		]) {
			handleMemoryTelemetry(ctx, payload)
		}
		ctx.flushLogBuffer()
		await vi.waitFor(() => {
			const events = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).filter(
				(event) => event.eventName === MEMORY_TELEMETRY_RECORDS.TOOL_COMPLETED,
			)
			expect(events).toHaveLength(2)
		})
		const events = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).filter(
			(event) => event.eventName === MEMORY_TELEMETRY_RECORDS.TOOL_COMPLETED,
		)
		expect(events[0]?.attrs).toMatchObject({
			tool: "memory_search",
			outcome: "hits",
			retrieved_count: "8",
			returned_count: "3",
		})
		expect(events[1]?.attrs).toMatchObject({ tool: "save_memory", outcome: "duplicate", returned_count: "0" })
	})

	it("drops cross-tool outcomes and missing tool counts", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleMemoryTelemetry(ctx, {
			event: "tool.completed",
			tool: "memory_search",
			outcome: "saved",
			durationMs: 5,
			retrievedCount: 8,
			returnedCount: 3,
		})
		handleMemoryTelemetry(ctx, { event: "tool.completed", tool: "save_memory", outcome: "saved", durationMs: 7 })
		ctx.flushLogBuffer()
		expect(logEvents(globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveLength(0)
	})
})
