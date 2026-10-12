/**
 * Regression tests for the "unknown model" steer-telemetry gap (Chunk 2,
 * LLM-3079): steer events fired before the first assistant message, or under
 * backend routing, must not report model="unknown" when a concrete session /
 * selection model exists. Mirrors the messages.ts reproduce environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { logEvents, type RecordedEvent } from "../otlp-test-utils.js"
import { _resetSharedAccumulators, TelemetryContext } from "../session-context.js"
import { handleSteerFired } from "./steers.js"

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

function attrsOf(events: RecordedEvent[], eventName: string): Record<string, unknown> | undefined {
	return events.find((record) => record.eventName === eventName)?.attrs
}

describe("handlers/steers — model resolution", () => {
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

	async function emittedWithModel(currentModel: string, lastRoutedModel?: string) {
		const ctx = new TelemetryContext(makeConfig())
		ctx.currentModel = currentModel
		ctx.lastRoutedModel = lastRoutedModel
		handleSteerFired(ctx, { kind: "continuation_nudge", reason: "empty_turn", steer_id: "f-1", interactive: true })
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])
		return logEvents(fetchMock)
	}

	it("a steer fired before the first assistant message carries the session selection model, not unknown", async () => {
		// Regression: ctx.model unset at session_start; the steer fires before any assistant message_end
		// resolved currentModel. The dashboard showed these as model="unknown".
		const events = await emittedWithModel("kimi-k3")
		expect(attrsOf(events, "steer.fired")).toMatchObject({ model: "kimi-k3" })
	})

	it("when currentModel is still unknown, the steer record reports model=currentModel as-is", async () => {
		// No model resolved yet at any layer — steer reports unknown honestly.
		const events = await emittedWithModel("unknown")
		expect(attrsOf(events, "steer.fired")).toMatchObject({ model: "unknown" })
	})

	it("under backend routing, the steer record adds routed_model alongside the virtual selection", async () => {
		const events = await emittedWithModel("auto", "kimi-k3")
		const attrs = attrsOf(events, "steer.fired")
		expect(attrs).toMatchObject({ model: "auto", routed_model: "kimi-k3" })
	})
})
