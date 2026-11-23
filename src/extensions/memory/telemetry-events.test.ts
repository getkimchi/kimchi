import { describe, expect, it, vi } from "vitest"
import {
	createMemoryTelemetryReporter,
	MEMORY_TELEMETRY_CHANNEL,
	type MemoryCaptureWaveTelemetry,
	memoryWorkerTelemetryProperties,
} from "./telemetry-events.js"

function wave(): MemoryCaptureWaveTelemetry {
	return {
		event: "capture.wave",
		outcome: "partial",
		durationMs: 1_250,
		jobCount: 4,
		storedCount: 3,
		triagedWindowCount: 2,
		nonDurableCount: 1,
		valuationDiscardCount: 1,
		redactedCount: 1,
		oversizedCount: 0,
		failedJobCount: 1,
		addQuarantinedCount: 1,
		poisonQuarantinedCount: 0,
		pendingCount: 2,
		oldestPendingMs: 9_000,
	}
}

describe("memory telemetry events", () => {
	it("publishes on the shared channel", () => {
		const publish = vi.fn()
		const reporter = createMemoryTelemetryReporter(publish)
		reporter({ event: "capture.spawn", outcome: "started" })
		expect(publish).toHaveBeenCalledExactlyOnceWith(MEMORY_TELEMETRY_CHANNEL, {
			event: "capture.spawn",
			outcome: "started",
		})
	})

	it("fails open and warns only once when publication fails", () => {
		const publish = vi.fn(() => {
			throw new Error("stale runtime")
		})
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const reporter = createMemoryTelemetryReporter(publish)
		expect(() => reporter({ event: "capture.spawn", outcome: "failed" })).not.toThrow()
		expect(() => reporter({ event: "capture.spawn", outcome: "started" })).not.toThrow()
		expect(publish).toHaveBeenCalledTimes(2)
		expect(warning).toHaveBeenCalledOnce()
		expect(warning.mock.calls[0]?.[0]).toContain("telemetry publication failed")
	})

	it("maps every capture-wave summary field to primitive pre-session properties", () => {
		expect(memoryWorkerTelemetryProperties(wave())).toEqual({
			outcome: "partial",
			duration_ms: 1_250,
			job_count: 4,
			stored_count: 3,
			triaged_window_count: 2,
			non_durable_count: 1,
			valuation_discard_count: 1,
			redacted_count: 1,
			oversized_count: 0,
			failed_job_count: 1,
			add_quarantined_count: 1,
			poison_quarantined_count: 0,
			pending_count: 2,
			oldest_pending_ms: 9_000,
		})
	})

	it("omits an unavailable oldest-pending age rather than reporting it as zero", () => {
		expect(memoryWorkerTelemetryProperties({ ...wave(), oldestPendingMs: undefined })).not.toHaveProperty(
			"oldest_pending_ms",
		)
	})

	it("maps fatal worker failures without raw error details", () => {
		expect(
			memoryWorkerTelemetryProperties({ event: "capture.failed", failureClass: "watchdog", durationMs: 42 }),
		).toEqual({ failure_class: "watchdog", duration_ms: 42 })
	})
})
