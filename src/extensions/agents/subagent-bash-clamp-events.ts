/**
 * Subagent bash-clamp domain event channel published via pi.events.
 *
 * The subagent bash wall-clock clamp (subagent-bash-clamp.ts) emits these
 * events; the telemetry extension subscribes and forwards them to OTLP as
 * `subagent.bash_clamped`. This keeps the clamp telemetry-free and makes
 * budget-containment observable: a clamped timeout is expected lifecycle
 * behavior, so the failure it produces is reported as this dedicated event
 * rather than a generic `error` / `tool_failure` record.
 *
 * Privacy: payloads carry structured fields only (agent type, clamp reason,
 * timeout values, remaining budget). Raw tool args and command text are
 * intentionally NOT emitted — mirroring the loop-guard / steer stance.
 */

export const SUBAGENT_BASH_CLAMP_EVENTS = {
	CLAMPED: "subagent_bash_clamp:clamped",
} as const

export type SubagentBashClampChannel = (typeof SUBAGENT_BASH_CLAMP_EVENTS)[keyof typeof SUBAGENT_BASH_CLAMP_EVENTS]

/** Why the clamp reduced the timeout: the budget was already exhausted
 *  (floor at 1s) or the remaining budget was below the resolved timeout. */
export type SubagentBashClampReason = "budget_exhausted" | "budget_tail"

export interface SubagentBashClampedPayload {
	/** Tool call id of the clamped bash call — lets telemetry reclassify the
	 *  resulting tool error (see handlers/tools.ts) instead of double-reporting. */
	toolCallId: string
	/** Agent type of the clamped subagent (matches subagent.spawned's agent_type). */
	agentType?: string
	/** Why the clamp fired. */
	reason: SubagentBashClampReason
	/** Timeout (seconds) the call would have used without the clamp
	 *  (explicit model request or the subagent default). */
	requestedTimeoutS: number
	/** Timeout (seconds) actually applied. */
	clampedToS: number
	/** Wall-clock ms of budget remaining at clamp time (≤ 0 when exhausted). */
	remainingMs: number
}
