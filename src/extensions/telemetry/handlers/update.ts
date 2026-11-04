/**
 * Translation for background-updater tick results (background-update
 * extension publishes on the pi.events bus) into OTLP records. Keeps
 * telemetry decoupled from the updater internals — same pattern as the
 * permissions / bash-tool-guard producers.
 *
 * Sinks: PostHog-only (analytics of update rates; precedent: tool_decision).
 * The ai-optimizer posthog_mapping + kimchiEvent allowlist follow-up lives
 * in the kubecast repo.
 *
 * Privacy: only enums and versions; `error` is the tick's truncated
 * (≤300 chars) failure reason.
 */

import { UPDATE_OUTCOMES, type UpdateOutcome } from "../../../update/state.js"
import type { TelemetryContext } from "../session-context.js"

export const UPDATE_TICK_EVENT = "update.tick"

interface UpdateTickPayload {
	outcome?: unknown
	version?: unknown
	error?: unknown
}

/**
 * Emit one `update.tick` log record per finished background update tick.
 * `update_version` is present for outcomes that resolved a target version;
 * `error` only for failures. Out-of-contract payloads are dropped rather
 * than exported.
 */
export function handleUpdateTick(tm: TelemetryContext, raw: unknown): void {
	const payload = raw as UpdateTickPayload | undefined
	if (typeof payload?.outcome !== "string" || !UPDATE_OUTCOMES.has(payload.outcome)) return
	const attrs: Record<string, string> = { outcome: payload.outcome as UpdateOutcome }
	if (typeof payload.version === "string") attrs.update_version = payload.version
	if (typeof payload.error === "string" && payload.error !== "") attrs.error = payload.error
	tm.emit(UPDATE_TICK_EVENT, attrs, undefined)
}
