/**
 * Translates steer/nudge domain events (steer:fired / steer:outcome) into
 * OTLP log records.
 *
 * Emitting extensions publish facts on the pi.events channels defined in
 * steer-events.ts; this handler forwards them to OTLP. Attributes are an
 * allowlist — kind, reason, interactive, is_subagent — so no raw tool args,
 * command text, file paths, or free-text reason strings can leak. The guard
 * kinds (bash_tool_guard, loop_guard) already emit on their own channels;
 * only their *outcome* events flow through here.
 */
import type { STEER_EVENTS, SteerAbortedPayload, SteerFiredPayload, SteerOutcomePayload } from "../../steer-events.js"
import type { TelemetryContext } from "../session-context.js"

/** Event attribute keys this handler is allowed to emit. Anything else in
 *  the payload is dropped — the privacy contract in steer-events.ts is
 *  enforced here as a defence-in-depth, mirrored by the handler tests.
 *  steer_id joins an outcome/aborted record to its fire. turn_index,
 *  ms_into_turn, steer_ordinal are stamped by the handler itself (from
 *  TelemetryContext), not carried in the payload — they're in the allowlist
 *  because they're handler-owned, which is what the allowlist asserts. */
const FIRED_ATTR_KEYS = [
	"kind",
	"reason",
	"steer_id",
	"turn_index",
	"ms_into_turn",
	"steer_ordinal",
	"is_subagent",
	"interactive",
] as const
const OUTCOME_ATTR_KEYS = ["kind", "outcome", "steer_id", "turns_to_outcome", "is_subagent", "interactive"] as const
const ABORTED_ATTR_KEYS = ["kind", "reason", "steer_id", "is_subagent", "interactive"] as const

export function handleSteerFired(ctx: TelemetryContext, raw: unknown): void {
	const payload = raw as Partial<SteerFiredPayload> | null | undefined
	if (typeof payload?.kind !== "string" || typeof payload.reason !== "string") return
	const steerId = typeof payload.steer_id === "string" ? payload.steer_id : undefined
	ctx.steerFiredCount += 1
	if (steerId) ctx.lastSteer = { kind: payload.kind, steerId, turnIndex: ctx.turnIndex }
	ctx.emit("steer.fired", {
		kind: payload.kind,
		reason: payload.reason,
		...(steerId ? { steer_id: steerId } : {}),
		turn_index: ctx.turnIndex,
		ms_into_turn: ctx.promptStartMs > 0 ? Date.now() - ctx.promptStartMs : 0,
		steer_ordinal: ctx.steerFiredCount,
		...(ctx.currentModel !== "unknown" ? { model: ctx.currentModel } : {}),
		...(ctx.lastRoutedModel ? { routed_model: ctx.lastRoutedModel } : {}),
		is_subagent: payload.is_subagent === true,
		interactive: payload.interactive === true,
	})
}

export function handleSteerOutcome(ctx: TelemetryContext, raw: unknown): void {
	const payload = raw as Partial<SteerOutcomePayload> | null | undefined
	if (
		typeof payload?.kind !== "string" ||
		(payload.outcome !== "complied" && payload.outcome !== "repeated" && payload.outcome !== "expired")
	)
		return
	ctx.emit("steer.outcome", {
		kind: payload.kind,
		outcome: payload.outcome,
		...(typeof payload.steer_id === "string" ? { steer_id: payload.steer_id } : {}),
		...(typeof payload.turns_to_outcome === "number" ? { turns_to_outcome: payload.turns_to_outcome } : {}),
		is_subagent: payload.is_subagent === true,
		interactive: payload.interactive === true,
	})
}

export function handleSteerAborted(ctx: TelemetryContext, raw: unknown): void {
	const payload = raw as Partial<SteerAbortedPayload> | null | undefined
	if (typeof payload?.kind !== "string" || typeof payload.reason !== "string") return
	ctx.emit("steer.aborted", {
		kind: payload.kind,
		reason: payload.reason,
		...(typeof payload.steer_id === "string" ? { steer_id: payload.steer_id } : {}),
		is_subagent: payload.is_subagent === true,
		interactive: payload.interactive === true,
	})
}

export type SteerEventChannelName = (typeof STEER_EVENTS)[keyof typeof STEER_EVENTS]

/** Exported for handler tests: the exact attribute allowlist per channel. */
export const STEER_TELEMETRY_ATTR_ALLOWLIST = {
	"steer:fired": FIRED_ATTR_KEYS,
	"steer:outcome": OUTCOME_ATTR_KEYS,
	"steer:aborted": ABORTED_ATTR_KEYS,
} as const
