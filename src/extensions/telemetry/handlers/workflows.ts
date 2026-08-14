/**
 * Translates workflow domain events (@kimchi-dev/kimchi-workflows) into OTLP log records.
 *
 * One generic handler for the whole contract — unlike the one-handler-per-channel ferment shape —
 * in three deliberate ways:
 *
 *  - Unknown `event` values are FORWARDED, not dropped: content-freedom is enforced producer-side,
 *    so a new producer event ships end-to-end with no change here.
 *  - Object fields flatten GENERICALLY, one level, into dotted attributes (`error.message`). Deeper
 *    nesting is dropped: anything past one level is a producer bug this side must not amplify.
 *  - No subscriber-side start-time maps: durations arrive producer-computed.
 */
import type { TelemetryAttributes, TelemetryContext } from "../session-context.js"
import type { WorkflowEventCommon } from "../workflow-events.js"

function isPrimitive(value: unknown): value is string | number | boolean {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

export function handleWorkflowEvent(ctx: TelemetryContext, raw: unknown): void {
	// Partial<common>, not the payload union: unknown events must pass; malformed input must fail the guards.
	const payload = raw as Partial<WorkflowEventCommon> | null | undefined
	const event = payload?.event
	if (typeof event !== "string" || event === "") return

	const attrs: TelemetryAttributes = {}
	for (const [key, value] of Object.entries(payload as object)) {
		if (key === "event") continue
		if (isPrimitive(value)) {
			attrs[key] = value
		} else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			for (const [innerKey, innerValue] of Object.entries(value)) {
				if (isPrimitive(innerValue)) attrs[`${key}.${innerKey}`] = innerValue
			}
		}
	}

	ctx.emit(`workflow.${event.replaceAll("_", ".")}`, attrs)
}
