/**
 * Steer/nudge domain event channels published via pi.events (plan E.1).
 *
 * Guard/nudge extensions emit these events; the telemetry extension
 * subscribes (handlers/steers.ts) and forwards them to OTLP. This keeps
 * guard code telemetry-free and makes every harness-injected steer
 * measurable in production, not just in benchmark transcripts.
 *
 * Events are defined at the *semantic* level — what nudge fired and why —
 * not the call-site level, so the contract survives mechanism swaps.
 *
 * Privacy: payloads carry structured fields only (kind, short reason code,
 * session-shape flags). Never raw tool args, command text, file paths, or
 * free-text reason strings — mirroring loop-guard-events.ts.
 *
 * Note: the two guard kinds (`bash_tool_guard`, `loop_guard`) already own
 * dedicated channels (`bash-tool-guard-events.ts`, `loop-guard-events.ts`).
 * Fire events for those two continue on their own channels; this file only
 * carries their *outcome* events, plus fire events for every other site.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "../cli-args.js"
import { isAgentWorker } from "./agent-worker-context.js"

export const STEER_EVENTS = {
	FIRED: "steer:fired",
	OUTCOME: "steer:outcome",
} as const

export type SteerEventChannel = (typeof STEER_EVENTS)[keyof typeof STEER_EVENTS]

/**
 * Semantic identity of the steer/nudge/guard surface. Kept short and stable
 * so telemetry can aggregate across harness versions.
 */
export type SteerKind =
	| "todo_early_nudge"
	| "todo_staleness"
	| "loop_guard"
	| "bash_tool_guard"
	| "bash_timeout_guidance"
	| "bash_control_checkin"
	| "exploration_guard"
	| "review_write_guard"
	| "continuation_nudge"
	| "planning_stop_nudge"

export interface SteerFiredPayload {
	/** Which steer/nudge surface fired. */
	kind: SteerKind
	/** Short stable reason code (e.g. "early_nudge", "staleness",
	 *  "empty_turn", "continuation"). No free text. */
	reason: string
	/** True when the fire happened inside an agent worker (subagent). */
	is_subagent: boolean
	/** True in interactive sessions (UI present); false in
	 *  print/protocol/benchmark sessions. */
	interactive: boolean
}

export interface SteerOutcomePayload {
	/** Which steer/nudge/guard surface the outcome belongs to. */
	kind: SteerKind
	/** Whether the agent complied with the steer (stopped the guarded
	 *  behaviour / adopted the nudge) or repeated the guarded behaviour /
	 *  ignored the nudge. */
	outcome: "complied" | "repeated"
	/** True when the outcome was observed inside an agent worker (subagent). */
	is_subagent: boolean
	/** True in interactive sessions (UI present); false in
	 *  print/protocol/benchmark sessions. */
	interactive: boolean
}

/** Session-shape flags shared by every payload. Sites that have a ctx
 *  pass `interactive: ctx.hasUI`; the default is derived from the session's
 *  parsed CLI args so ctx-less emit sites still classify correctly. */
export interface SteerSessionShape {
	/** True when the fire happened inside an agent worker (subagent). */
	is_subagent: boolean
	/** True in interactive sessions (UI present); false in
	 *  print/protocol/benchmark sessions. */
	interactive: boolean
}

/**
 * Emit a steer-fire event. The subagent flag is derived from the ambient
 * worker context; `interactive` defaults to true and should be overridden
 * with `ctx.hasUI` where a context is available.
 */
function defaultInteractive(): boolean {
	const parsed = getParsedCliArgs()
	return !(parsed.options.print === true || (parsed.options.mode !== undefined && parsed.options.mode !== "text"))
}
export function emitSteerFired(
	pi: ExtensionAPI,
	kind: SteerKind,
	reason: string,
	shape: { interactive?: boolean } = {},
): void {
	if (isSteerDisabled(kind)) return
	const payload: SteerFiredPayload = {
		kind,
		reason,
		is_subagent: isAgentWorker(),
		interactive: shape.interactive ?? defaultInteractive(),
	}
	try {
		pi.events.emit(STEER_EVENTS.FIRED, payload)
	} catch {
		// pi.events may be unavailable on older hosts or lightweight test
		// mocks. The steer still functions without telemetry (precedent:
		// bash-tool-guard.ts / loop-guard.ts domain event emitters).
	}
}

export function emitSteerOutcome(
	pi: ExtensionAPI,
	kind: SteerKind,
	outcome: SteerOutcomePayload["outcome"],
	shape: { interactive?: boolean } = {},
): void {
	if (isSteerDisabled(kind)) return
	const payload: SteerOutcomePayload = {
		kind,
		outcome,
		is_subagent: isAgentWorker(),
		interactive: shape.interactive ?? defaultInteractive(),
	}
	try {
		pi.events.emit(STEER_EVENTS.OUTCOME, payload)
	} catch {
		// pi.events may be unavailable on older hosts or lightweight test
		// mocks. The steer still functions without telemetry.
	}
}

/**
 * Per-nudge/per-guard kill switches (plan E.4).
 *
 * Flag naming: steers use `KIMCHI_DISABLE_NUDGE_<KIND>`, guards use
 * `KIMCHI_DISABLE_GUARD_<KIND>` — mirroring the existing
 * `bash_tool_guard` / `loop_guard` names so the flag is discoverable from
 * the feature name. Flags are read ad-hoc (repo precedent:
 * `src/ferment/types.ts:218`) and default to OFF (unset = current
 * behaviour, bit-identical prompts).
 */
const STEER_DISABLE_FLAGS: Record<SteerKind, string> = {
	todo_early_nudge: "KIMCHI_DISABLE_NUDGE_TODO_EARLY",
	todo_staleness: "KIMCHI_DISABLE_NUDGE_STALENESS",
	loop_guard: "KIMCHI_DISABLE_GUARD_LOOP",
	bash_tool_guard: "KIMCHI_DISABLE_GUARD_BASH_TOOL",
	bash_timeout_guidance: "KIMCHI_DISABLE_NUDGE_BASH_TIMEOUT",
	bash_control_checkin: "KIMCHI_DISABLE_NUDGE_BASH_CONTROL_CHECKIN",
	exploration_guard: "KIMCHI_DISABLE_NUDGE_EXPLORATION",
	review_write_guard: "KIMCHI_DISABLE_NUDGE_REVIEW_WRITE",
	continuation_nudge: "KIMCHI_DISABLE_NUDGE_CONTINUATION",
	planning_stop_nudge: "KIMCHI_DISABLE_NUDGE_PLANNING_STOP",
}

/** True when the steer surface for `kind` is disabled via its env flag. */
export function isSteerDisabled(kind: SteerKind): boolean {
	return process.env[STEER_DISABLE_FLAGS[kind]] === "1"
}

/** Env var name for a steer kind's kill switch (for docs/tests). */
export function steerDisableFlagName(kind: SteerKind): string {
	return STEER_DISABLE_FLAGS[kind]
}
