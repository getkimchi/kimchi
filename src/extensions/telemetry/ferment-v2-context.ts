// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { SessionFermentV2 } from "../ferment-v2/types.js"

/**
 * The active ferment v2 identity used for telemetry enrichment
 * (`ferment_id`/`ferment_v2_id`/`ferment_revision`/`status` attributes and the
 * `session_type: "ferment"` classification).
 *
 * This used to be module-global mutable state, which let one session's
 * CONTEXT_CHANGED channel event bleed into every other session's emitted
 * attributes in a concurrent multi-session process. It now lives on the
 * per-session TelemetryContext instance and is set only by the handler
 * subscribed on that instance's own event bus.
 */
export type TelemetryFermentV2Context = Pick<SessionFermentV2, "id" | "revision" | "status">
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
