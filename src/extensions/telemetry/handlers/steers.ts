/**
 * Translates steer/nudge domain events (steer:fired / steer:outcome) into
 * OTLP log records (plan E.2).
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
 *  enforced here as a defence-in-depth, mirrored by the handler tests. */
const FIRED_ATTR_KEYS = ["kind", "reason", "is_subagent", "interactive"] as const
const OUTCOME_ATTR_KEYS = ["kind", "outcome", "is_subagent", "interactive"] as const
const ABORTED_ATTR_KEYS = ["kind", "reason", "is_subagent", "interactive"] as const

export function handleSteerFired(ctx: TelemetryContext, raw: unknown): void {
	const payload = raw as Partial<SteerFiredPayload> | null | undefined
	if (typeof payload?.kind !== "string" || typeof payload.reason !== "string") return
	ctx.emit("steer.fired", {
		kind: payload.kind,
		reason: payload.reason,
		is_subagent: payload.is_subagent === true,
		interactive: payload.interactive === true,
	})
}

export function handleSteerOutcome(ctx: TelemetryContext, raw: unknown): void {
	const payload = raw as Partial<SteerOutcomePayload> | null | undefined
	if (typeof payload?.kind !== "string" || (payload.outcome !== "complied" && payload.outcome !== "repeated")) return
	ctx.emit("steer.outcome", {
		kind: payload.kind,
		outcome: payload.outcome,
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
