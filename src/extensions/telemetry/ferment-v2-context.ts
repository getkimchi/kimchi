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
