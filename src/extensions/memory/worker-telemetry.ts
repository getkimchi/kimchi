/**
 * Pre-session telemetry for short-lived memory capture workers. The worker
 * reads effective consent and endpoint config in its own process; no pi
 * session context or originating-session correlation exists here.
 */
import type { TelemetryConfig } from "../../config.js"
import { readEffectiveTelemetryConfig } from "../../telemetry-policy.js"
import { drain as drainPreSessionTelemetry, sendPreSessionEvent } from "../telemetry/pre-session.js"
import { type MemoryWorkerTelemetryEvent, memoryWorkerTelemetryProperties } from "./telemetry-events.js"

export interface MemoryWorkerTelemetrySink {
	report(event: MemoryWorkerTelemetryEvent): void
	drain(): Promise<void>
}

const NOOP_SINK: MemoryWorkerTelemetrySink = {
	report: () => undefined,
	drain: async () => undefined,
}

export function createMemoryWorkerTelemetrySink(config: TelemetryConfig): MemoryWorkerTelemetrySink {
	return {
		report: (event) => {
			const name = event.event === "capture.wave" ? "memory.capture.wave" : "memory.capture.failed"
			sendPreSessionEvent(config, name, memoryWorkerTelemetryProperties(event))
		},
		drain: drainPreSessionTelemetry,
	}
}

/** Resolve worker-local config without allowing a config failure to break capture. */
export function resolveMemoryWorkerTelemetrySink(): MemoryWorkerTelemetrySink {
	try {
		return createMemoryWorkerTelemetrySink(readEffectiveTelemetryConfig())
	} catch (err) {
		console.warn(
			"[memory-capture] telemetry config unavailable; continuing without worker telemetry:",
			err instanceof Error ? err.message : err,
		)
		return NOOP_SINK
	}
}

/** Best-effort emission around every worker call site, including injected test sinks. */
export function reportMemoryWorkerTelemetry(
	sink: MemoryWorkerTelemetrySink | undefined,
	event: MemoryWorkerTelemetryEvent,
): void {
	try {
		sink?.report(event)
	} catch (err) {
		console.warn(
			"[memory-capture] telemetry emission failed; capture continues:",
			err instanceof Error ? err.message : err,
		)
	}
}

/** Preserve the worker's original result/exit code when telemetry cannot drain. */
export async function drainMemoryWorkerTelemetry(sink: MemoryWorkerTelemetrySink): Promise<void> {
	try {
		await sink.drain()
	} catch (err) {
		console.warn(
			"[memory-capture] telemetry drain failed; worker result is unchanged:",
			err instanceof Error ? err.message : err,
		)
	}
}
