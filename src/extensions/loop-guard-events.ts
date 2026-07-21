/**
 * Loop-guard domain event channels published via pi.events.
 *
 * The loop-guard extension emits these events; the telemetry extension
 * subscribes to them. This keeps the guard isolated from telemetry and
 * ensures every steer / subagent abort is observed for analytics.
 *
 * Privacy: payloads carry structured fields only (detector, count,
 * is_subagent). Raw tool args, command text, and the human reason string
 * are intentionally NOT emitted — mirroring the bash-tool-guard stance.
 */

export const LOOP_GUARD_EVENTS = {
	WARN: "loop_guard:warn",
	SUBAGENT_ABORT: "loop_guard:subagent_abort",
} as const

export type LoopGuardEventChannel = (typeof LOOP_GUARD_EVENTS)[keyof typeof LOOP_GUARD_EVENTS]

/**
 * Which loop detector fired. Kept short and stable so telemetry can
 * aggregate without receiving raw tool-arg / command text.
 */
export type LoopGuardDetector =
	| "consecutive_identical"
	| "exact_ngram"
	| "fuzzy_ngram"
	| "edit_run"
	| "edit_run_total"
	| "repeated_edit"
	| "bash_repetition"

export interface LoopGuardWarnPayload {
	/** The detector that fired this warn. */
	detector: LoopGuardDetector
	/** How many times the guard has warned in the session so far. */
	count: number
	/** True when the warning fired inside an agent worker (subagent). */
	is_subagent: boolean
}

export interface LoopGuardSubagentAbortPayload {
	/** The detector that triggered the warn preceding this abort. May be
	 *  undefined if the warn happened before detector tracking was added
	 *  or in edge cases where no detector was stashed. */
	detector?: LoopGuardDetector
	/** The session warn count at the time of the triggering warn. */
	count: number
	/** Always true — aborts only fire for subagents. */
	is_subagent: boolean
}
