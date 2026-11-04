// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { getActiveFerment } from "../ferment/index.js"
import type { TelemetryFermentV2Context } from "./ferment-v2-context.js"

/**
 * Session type classification for telemetry attributes. The ferment v2
 * context is the caller's per-instance value (see TelemetryFermentV2Context);
 * the v1 active ferment is domain-owned process state and stays global.
 */
export function getSessionType(fermentV2?: TelemetryFermentV2Context): "ferment" | "coding" {
	if (fermentV2) return "ferment"
	return getActiveFerment() ? "ferment" : "coding"
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
