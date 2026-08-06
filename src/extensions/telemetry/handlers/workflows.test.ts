import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { logEvents, type RecordedEvent } from "../otlp-test-utils.js"
import { _resetSharedAccumulators, TelemetryContext } from "../session-context.js"
import { handleWorkflowEvent } from "./workflows.js"

vi.mock("../../../api/me.js", () => ({
	getMe: vi.fn().mockResolvedValue({ id: "test-user", email: "test@example.com" }),
}))

function makeConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
	return {
		enabled: true,
		endpoint: "https://test.example.com/logs",
		metricsEndpoint: "https://test.example.com/metrics",
		headers: { Authorization: "Bearer test" },
		apiKey: "",
		...overrides,
	}
}

/** Attrs of one record by its full OTLP name — spelled out per call site to assert the name derivation. */
function attrsOf(events: RecordedEvent[], eventName: string): Record<string, string> | undefined {
	return events.find((record) => record.eventName === eventName)?.attrs
}

const RUN_ID = "workflow-demo-1a2b3c4d"
const AT = "2026-01-01T00:00:00.000Z"

describe("handlers/workflows", () => {
	let originalFetch: typeof globalThis.fetch
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		originalFetch = globalThis.fetch
		fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: vi.fn().mockResolvedValue(""),
		} as unknown as Response)
		globalThis.fetch = fetchMock
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		_resetSharedAccumulators()
		vi.restoreAllMocks()
	})

	async function emitted(raw: unknown): Promise<RecordedEvent[]> {
		const ctx = new TelemetryContext(makeConfig())
		handleWorkflowEvent(ctx, raw)
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])
		return logEvents(fetchMock)
	}

	it("derives the OTLP name mechanically and passes the fields through, minus `event`", async () => {
		const events = await emitted({
			event: "run_started",
			run_id: RUN_ID,
			workflow_name: "demo",
			at: AT,
		})

		const attrs = attrsOf(events, "workflow.run.started")
		expect(attrs?.run_id).toBe(RUN_ID)
		expect(attrs?.workflow_name).toBe("demo")
		expect(attrs?.at).toBe(AT)
		// The discriminator is encoded in the event name; carrying it again would be noise.
		expect(attrs).not.toHaveProperty("event")
		// Ambient identifiers are layered on by the shared emit path.
		expect(attrs?.["session.id"]).toBeDefined()
	})

	it("flattens the error envelope into dotted attributes — the step_retried shape end to end", async () => {
		const events = await emitted({
			event: "step_retried",
			run_id: RUN_ID,
			workflow_name: "demo",
			at: AT,
			step_name: "review",
			attempt: 3,
			reason: "context_window",
			error: { message: "the input is longer than the context length" },
		})

		const attrs = attrsOf(events, "workflow.step.retried")
		expect(attrs?.step_name).toBe("review")
		expect(attrs?.attempt).toBe("3")
		expect(attrs?.reason).toBe("context_window")
		expect(attrs?.["error.message"]).toBe("the input is longer than the context length")
		expect(attrs).not.toHaveProperty("error")
	})

	it("flattens envelope fields it has never heard of — producer envelope growth ships without a change here", async () => {
		const events = await emitted({
			event: "step_failed",
			run_id: RUN_ID,
			workflow_name: "demo",
			at: AT,
			step_name: "gate",
			error: { message: "gate did not pass", retryable: false, kind: "verification" },
		})

		const attrs = attrsOf(events, "workflow.step.failed")
		expect(attrs).toBeDefined()
		expect(attrs?.["error.message"]).toBe("gate did not pass")
		expect(attrs?.["error.retryable"]).toBe("false")
		expect(attrs?.["error.kind"]).toBe("verification")
	})

	it("forwards an event type it has never heard of — producer additions ship without a change here", async () => {
		const events = await emitted({
			event: "loop_iteration",
			run_id: RUN_ID,
			workflow_name: "demo",
			at: AT,
			iteration: 2,
		})

		const attrs = attrsOf(events, "workflow.loop.iteration")
		expect(attrs).toBeDefined()
		expect(attrs?.iteration).toBe("2")
	})

	it("drops arrays and anything nested past one level — the contract says one level of primitives", async () => {
		const events = await emitted({
			event: "run_completed",
			run_id: RUN_ID,
			workflow_name: "demo",
			at: AT,
			tags: ["a", "b"],
			error: { message: "ok", details: { stack: "do-not-export-this" } },
		})

		const attrs = attrsOf(events, "workflow.run.completed")
		expect(attrs).toBeDefined()
		expect(attrs).not.toHaveProperty("tags")
		expect(attrs?.["error.message"]).toBe("ok")
		expect(attrs).not.toHaveProperty("error.details")
		expect(JSON.stringify(attrs)).not.toContain("do-not-export-this")
	})

	it("omits undefined fields instead of exporting empty attributes", async () => {
		const events = await emitted({
			event: "run_completed",
			run_id: RUN_ID,
			workflow_name: "demo",
			at: AT,
			duration_ms: undefined,
		})

		const attrs = attrsOf(events, "workflow.run.completed")
		expect(attrs).toBeDefined()
		expect(attrs).not.toHaveProperty("duration_ms")
	})

	it.each([
		undefined,
		null,
		"not an object",
		42,
		{},
		{ event: "" },
		{ event: 7 },
	])("emits nothing for a payload with no usable discriminator: %j", async (raw) => {
		const events = await emitted(raw)
		expect(events.filter((record) => record.eventName.startsWith("workflow."))).toEqual([])
	})
})
