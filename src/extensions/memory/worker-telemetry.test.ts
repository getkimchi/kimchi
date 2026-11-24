import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../config.js"
import { readEffectiveTelemetryConfig } from "../../telemetry-policy.js"
import { drain, sendPreSessionEvent } from "../telemetry/pre-session.js"
import {
	createMemoryWorkerTelemetrySink,
	drainMemoryWorkerTelemetry,
	reportMemoryWorkerTelemetry,
	resolveMemoryWorkerTelemetrySink,
} from "./worker-telemetry.js"

vi.mock("../../telemetry-policy.js", () => ({ readEffectiveTelemetryConfig: vi.fn() }))
vi.mock("../telemetry/pre-session.js", () => ({ sendPreSessionEvent: vi.fn(), drain: vi.fn() }))

const config: TelemetryConfig = {
	enabled: true,
	endpoint: "https://telemetry.test/logs:ingest",
	metricsEndpoint: "https://telemetry.test/metrics:ingest",
	headers: { Authorization: "Bearer test" },
	apiKey: "test",
}

describe("memory worker telemetry", () => {
	beforeEach(() => {
		vi.mocked(sendPreSessionEvent).mockReset()
		vi.mocked(drain).mockReset().mockResolvedValue(undefined)
		vi.mocked(readEffectiveTelemetryConfig).mockReset().mockReturnValue(config)
	})

	it("uses worker-local effective config and bounded pre-session properties", () => {
		const sink = createMemoryWorkerTelemetrySink(config)
		sink.report({
			event: "capture.wave",
			outcome: "completed",
			durationMs: 100,
			jobCount: 1,
			storedCount: 1,
			triagedWindowCount: 0,
			nonDurableCount: 0,
			valuationDiscardCount: 0,
			redactedCount: 0,
			oversizedCount: 0,
			failedJobCount: 0,
			addQuarantinedCount: 0,
			poisonQuarantinedCount: 0,
			pendingCount: 0,
		})
		sink.report({ event: "capture.failed", failureClass: "watchdog", durationMs: 50 })
		expect(sendPreSessionEvent).toHaveBeenNthCalledWith(
			1,
			config,
			"memory.capture.wave",
			expect.objectContaining({ job_count: 1, stored_count: 1, pending_count: 0, duration_ms: 100 }),
		)
		expect(sendPreSessionEvent).toHaveBeenNthCalledWith(2, config, "memory.capture.failed", {
			failure_class: "watchdog",
			duration_ms: 50,
		})
	})

	it("resolves effective config in the worker and drains before exit", async () => {
		const sink = resolveMemoryWorkerTelemetrySink()
		expect(readEffectiveTelemetryConfig).toHaveBeenCalledOnce()
		await drainMemoryWorkerTelemetry(sink)
		expect(drain).toHaveBeenCalledOnce()
	})

	it("keeps capture operational when config, sinks, or drains fail", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined)
		vi.mocked(readEffectiveTelemetryConfig).mockImplementation(() => {
			throw new Error("no config")
		})
		const sink = resolveMemoryWorkerTelemetrySink()
		expect(() =>
			reportMemoryWorkerTelemetry(sink, { event: "capture.failed", failureClass: "startup", durationMs: 0 }),
		).not.toThrow()
		await expect(drainMemoryWorkerTelemetry(sink)).resolves.toBeUndefined()

		const failing = {
			report: vi.fn(() => {
				throw new Error("send failed")
			}),
			drain: vi.fn().mockRejectedValue(new Error("drain failed")),
		}
		expect(() =>
			reportMemoryWorkerTelemetry(failing, { event: "capture.failed", failureClass: "drain", durationMs: 1 }),
		).not.toThrow()
		await expect(drainMemoryWorkerTelemetry(failing)).resolves.toBeUndefined()
	})
})
