/**
 * Steer/nudge domain event channels published via pi.events.
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
 * Note: the two guard kinds (`bash_tool_guard`, `loop_guard`) also own
 * dedicated domain channels (`bash-tool-guard-events.ts`,
 * `loop-guard-events.ts`) for guard-specific payloads; their `steer:fired`
 * events land here too (warn sites call emitSteerFired after sending the
 * steer), and this file carries their *outcome* events.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "../cli-args.js"
import { isAgentWorker } from "./agent-worker-context.js"
import { markHarnessSteer } from "./steer-marker.js"

export const STEER_EVENTS = {
	FIRED: "steer:fired",
	OUTCOME: "steer:outcome",
	ABORTED: "steer:aborted",
} as const

export type SteerEventChannel = (typeof STEER_EVENTS)[keyof typeof STEER_EVENTS]

/**
 * Semantic identity of the steer/nudge/guard surface. Kept short and stable
 * so telemetry can aggregate across harness versions.
 */
export type SteerKind =
	| "todo_early_nudge"
	| "todo_staleness"
	| "todo_checkin"
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
	/** Random per-fire identifier, generated at the emit site and returned by
	 *  emitSteerFired so an outcome watcher can attribute its outcome/aborted
	 *  event back to this exact fire. Not deterministic — a random UUID is
	 *  fine, since the join is only ever outcome ↔ fire. */
	steer_id: string
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
	 *  ignored the nudge. Chunk 3 adds "expired" and the watcher module; until
	 *  then only the two values below are emitted. */
	outcome: "complied" | "repeated" | "expired"
	/** How the outcome was produced, when the emitter tracks it. Used by the
	 *  todo check-in gate to distinguish reconciliation by write vs confirm
	 *  and failed confirmation attempts (wrong expected set, stale input
	 *  revision). Closed vocabulary — no free text. */
	method?: "write" | "confirm" | "mismatch" | "stale_revision"
	/** steer_id of the fire this outcome belongs to. Emitters that track the
	 *  fire pass it explicitly (the watcher-based kinds); everyone else is
	 *  attributed automatically to the most recent fire of the same kind in
	 *  the session (see `lastFireBySessionKind`). */
	steer_id?: string
	/** Turns between the fire and this outcome, when the emitter tracks it.
	 *  Also stamped by the self-attribution fallback in emitSteerOutcome. */
	turns_to_outcome?: number
	/** True when the outcome was observed inside an agent worker (subagent). */
	is_subagent: boolean
	/** True in interactive sessions (UI present); false in
	 *  print/protocol/benchmark sessions. */
	interactive: boolean
}

export interface SteerAbortedPayload {
	/** Which steer/nudge/guard surface the aborted turn followed. */
	kind: SteerKind
	/** The short reason code of the steer that preceded the abort. */
	reason: string
	/** steer_id of the attributed fire, when the abort tracker holds one. */
	steer_id?: string
	/** True when the abort happened inside an agent worker (subagent).
	 *  (A user Esc abort is, by definition, the main session — but the
	 *  payload keeps the flag for shape parity with the other events.) */
	is_subagent: boolean
	/** True in interactive sessions (UI present); false in
	 *  print/protocol/benchmark sessions. */
	interactive: boolean
}

/** Short stable reason code carried by every steer event. A closed union,
 *  not a free string, so telemetry aggregation stays reliable across
 *  harness versions. Extension-specific reasons extend this union rather
 *  than widening it to `string`. */
export type SteerReason =
	| "early_nudge"
	| "staleness"
	| "empty_turn"
	| "continuation"
	| "scoping_stop"
	| "step_stall"
	| "timeout"
	| "checkin"
	| "plan_submission"
	| "warn"
	| "steer"
	| "turn_end"

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
 * Emit a steer-fire event and return the generated per-fire id (undefined
 * when the steer was kill-switch suppressed). The subagent flag is derived
 * from the ambient worker context; `interactive` defaults to the CLI-args
 * classification and should be overridden with `ctx.hasUI` where a context
 * is available. `sessionId` keys the abort tracker (prevents cross-session
 * attribution on multi-session hosts like ACP); leave it unset only at
 * ctx-less emit sites, where the single-session fallback key is correct.
 * Outcome watchers must hold the returned id and pass it to
 * emitSteerOutcome so the outcome joins back to this exact fire.
 */
function defaultInteractive(): boolean {
	try {
		const parsed = getParsedCliArgs()
		return !(parsed.options.print === true || (parsed.options.mode !== undefined && parsed.options.mode !== "text"))
	} catch {
		// CLI args may be unpopulated on some host paths (older pi versions,
		// embedded hosts). Treat as interactive rather than failing the steer.
		return true
	}
}
export function emitSteerFired(
	pi: ExtensionAPI,
	kind: SteerKind,
	reason: SteerReason,
	shape: { interactive?: boolean; sessionId?: string } = {},
): string | undefined {
	if (isSteerDisabled(kind)) return undefined
	const payload: SteerFiredPayload = {
		kind,
		reason,
		steer_id: crypto.randomUUID(),
		is_subagent: isAgentWorker(),
		interactive: shape.interactive ?? defaultInteractive(),
	}
	try {
		pi.events.emit(STEER_EVENTS.FIRED, payload)
		trackLastSteerFired(shape.sessionId ?? "", kind, reason, payload.steer_id, payload.interactive)
		trackLastFire(shape.sessionId ?? "", kind, payload.steer_id)
	} catch {
		// pi.events may be unavailable on older hosts or lightweight test
		// mocks. The steer still functions without telemetry (precedent:
		// bash-tool-guard.ts / loop-guard.ts domain event emitters).
	}
	return payload.steer_id
}

// ---------------------------------------------------------------------------
// Outcome self-attribution — the last fire per (session, kind)
// ---------------------------------------------------------------------------
// Emitters with bespoke outcome windows (bash_tool_guard, loop_guard,
// todo_early_nudge, check-in reconciliations without an opening id) do not
// hold the fire id their emitSteerFired returned. This registry bridges that
// gap: every fire records itself here, and emitSteerOutcome attributes id-less
// outcomes to the most recent same-kind fire in the same session. Unlike the
// abort tracker below, entries survive user input (a conversation turn
// between the steer and its outcome is normal) and are only cleared on
// session shutdown. The empty session key is the ctx-less fallback (single-
// session hosts), mirroring trackLastSteerFired below.

interface LastFire {
	steerId: string
	/** Session turn count at fire time; turns_to_outcome = now - turnAtFire. */
	turnAtFire: number
}

const lastFireBySessionKind = new Map<string, Map<SteerKind, LastFire>>()

/** Completed turns per session, incremented by steerAbortTrackerExtension on
 *  every turn_end. Registration order in cli.ts places this extension before
 *  the outcome watcher, so by the time the watcher classifies a turn_end the
 *  counter is already incremented — matching the watcher's turnsElapsed. */
const turnCountBySession = new Map<string, number>()

function trackLastFire(sessionId: string, kind: SteerKind, steerId: string): void {
	let byKind = lastFireBySessionKind.get(sessionId)
	if (!byKind) {
		byKind = new Map()
		lastFireBySessionKind.set(sessionId, byKind)
	}
	byKind.set(kind, { steerId, turnAtFire: turnCountBySession.get(sessionId) ?? 0 })
}

export function emitSteerOutcome(
	pi: ExtensionAPI,
	kind: SteerKind,
	outcome: SteerOutcomePayload["outcome"],
	shape: {
		interactive?: boolean
		sessionId?: string
		steerId?: string
		turnsToOutcome?: number
		method?: SteerOutcomePayload["method"]
	} = {},
): void {
	if (isSteerDisabled(kind)) return
	// Self-attribution fallback: attribute id-less outcomes to the most recent
	// same-kind fire in the session, and stamp turns for emitters that know
	// the fire id but not the turn count (todo_checkin). Explicit shape values
	// always win, and turns are only stamped when the explicit id matches the
	// registry fire — a mismatch means the outcome belongs to an older fire,
	// so the registry's turn count would be wrong.
	const sessionId = shape.sessionId ?? ""
	const fallback =
		shape.steerId === undefined || shape.turnsToOutcome === undefined
			? lastFireBySessionKind.get(sessionId)?.get(kind)
			: undefined
	const fallbackApplies = fallback !== undefined && (shape.steerId === undefined || shape.steerId === fallback.steerId)
	const steerId = shape.steerId ?? (fallbackApplies && fallback ? fallback.steerId : undefined)
	// The ctx-less "" key has no turn counter (it only ticks via a session ctx),
	// so elapsed turns are unknowable there — omit rather than stamp a wrong 0.
	const turnsToOutcome =
		shape.turnsToOutcome ??
		(fallbackApplies && fallback && sessionId !== ""
			? (turnCountBySession.get(sessionId) ?? 0) - fallback.turnAtFire
			: undefined)
	const payload: SteerOutcomePayload = {
		kind,
		outcome,
		...(shape.method !== undefined ? { method: shape.method } : {}),
		...(steerId !== undefined ? { steer_id: steerId } : {}),
		...(turnsToOutcome !== undefined ? { turns_to_outcome: turnsToOutcome } : {}),
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
 * Send a hidden steer/nudge message and record its fire event in one call.
 *
 * This is the shared path for the simple guard-reason steer family — sites
 * whose shape is exactly: kill-switch gate → `pi.sendMessage` with a
 * marked text block (`deliverAs: "steer"`, no details) → `emitSteerFired`.
 * Sites with different delivery mechanics keep their own helpers:
 * `todos/staleness-steers.ts` (`sendHiddenSteer`, needs `details` + custom
 * customType), the continuation nudges (`followUp` + pre-marked constants),
 * and the two domain-channel guards (`bash_tool_guard`, `loop_guard`).
 *
 * Returns the emitted fire's steer_id (undefined when kill-switch
 * suppressed — "no steer was sent"), so callers with an outcome watcher can
 * attribute the outcome back to this exact fire. Callers that only need the
 * boolean check keep working: the return is truthy iff a steer was sent.
 */
export function sendSteer(
	pi: ExtensionAPI,
	ctx: ExtensionContext | undefined,
	opts: {
		kind: SteerKind
		reason: SteerReason
		customType: string
		text: string
		deliverAs?: "steer" | "followUp"
	},
): string | undefined {
	if (isSteerDisabled(opts.kind)) return undefined
	pi.sendMessage(
		{
			customType: opts.customType,
			content: [{ type: "text", text: markHarnessSteer(opts.text) }],
			display: false,
		},
		{ deliverAs: opts.deliverAs ?? "steer" },
	)
	return emitSteerFired(pi, opts.kind, opts.reason, {
		interactive: ctx?.hasUI,
		sessionId: ctx?.sessionManager.getSessionId(),
	})
}

/**
 * Per-nudge/per-guard kill switches.
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
	todo_checkin: "KIMCHI_DISABLE_NUDGE_TODO_CHECKIN",
	loop_guard: "KIMCHI_DISABLE_GUARD_LOOP",
	bash_tool_guard: "KIMCHI_DISABLE_GUARD_BASH_TOOL",
	bash_timeout_guidance: "KIMCHI_DISABLE_NUDGE_BASH_TIMEOUT",
	bash_control_checkin: "KIMCHI_DISABLE_NUDGE_BASH_CONTROL_CHECKIN",
	exploration_guard: "KIMCHI_DISABLE_GUARD_EXPLORATION",
	review_write_guard: "KIMCHI_DISABLE_GUARD_REVIEW_WRITE",
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

// ---------------------------------------------------------------------------
// steer:aborted — user-veto outcome for the most recent steer
// ---------------------------------------------------------------------------
// Model-compliance outcomes (steer:outcome) don't capture the case where the
// model obeyed the steer but the *human* vetoed the resulting work with Esc.
// This small tracker bridges that gap: emitSteerFired records the most recent
// steer; a turn_end with stopReason "aborted" while a steer is pending emits
// steer:aborted with that kind. Real user input clears the tracker so an
// unrelated later abort is not attributed to a steer.

/** Most recent steer fired per session, pending an abort-attribution check.
 *  Keyed by sessionId so concurrent sessions (ACP hosts) can't misattribute
 *  an abort in one session to a steer fired in another. The empty key is the
 *  fallback for ctx-less emit sites (correct on single-session hosts). */
const lastSteerFiredBySession = new Map<
	string,
	{ kind: SteerKind; reason: string; steerId: string; interactive: boolean }
>()

/** Kinds excluded from abort attribution. bash_control_checkin fires on every
 *  still-running poll — tracking it would poison the tracker in any session
 *  with background work (every abort becomes "vetoed a checkin"). Polling a
 *  handle is not a message the user vetoes anyway. */
const ABORT_TRACKING_EXCLUDED_KINDS: ReadonlySet<SteerKind> = new Set(["bash_control_checkin"])

/** Record the fired steer as the abort-attribution candidate for its session.
 *  Called by emitSteerFired. Sessions whose steer kind is excluded from abort
 *  tracking keep their previous candidate. Note: emitSteerFired early-returns
 *  WITHOUT tracking when the kill switch suppresses the steer — a disabled
 *  steer can't be vetoed, so nothing new is recorded. */
function trackLastSteerFired(
	sessionId: string,
	kind: SteerKind,
	reason: string,
	steerId: string,
	interactive: boolean,
): void {
	if (ABORT_TRACKING_EXCLUDED_KINDS.has(kind)) return
	lastSteerFiredBySession.set(sessionId, { kind, reason, steerId, interactive })
}

/** Test-only: clear the module-level trackers between tests (abort tracker,
 *  fire registry, turn counters). */
export function resetSteerAbortTracker(): void {
	lastSteerFiredBySession.clear()
	lastFireBySessionKind.clear()
	turnCountBySession.clear()
}

/**
 * Extension that emits `steer:aborted` when the user aborts (Esc) the turn
 * immediately following a harness steer — the "user vetoed the nudge" signal.
 * The model-compliance three-way read then becomes: complied / model-ignored /
 * human-vetoed.
 */
export function steerAbortTrackerExtension(pi: ExtensionAPI): void {
	pi.on("input", (event, ctx) => {
		// Real user input (not an extension's injection) means any later abort
		// is the user interrupting their own request — attribute nothing.
		if (event.source !== "extension") lastSteerFiredBySession.delete(ctx.sessionManager.getSessionId())
	})

	pi.on("turn_end", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId()
		// Turn counter first (feeds turns_to_outcome on self-attributed
		// outcomes), then the abort-attribution check.
		turnCountBySession.set(sessionId, (turnCountBySession.get(sessionId) ?? 0) + 1)
		const steer = lastSteerFiredBySession.get(sessionId)
		if (!steer) return
		lastSteerFiredBySession.delete(sessionId)
		if (event.message.role !== "assistant") return
		if (event.message.stopReason !== "aborted") return
		if (isSteerDisabled(steer.kind)) return
		const payload: SteerAbortedPayload = {
			kind: steer.kind,
			reason: steer.reason,
			steer_id: steer.steerId,
			is_subagent: isAgentWorker(),
			interactive: steer.interactive,
		}
		try {
			pi.events.emit(STEER_EVENTS.ABORTED, payload)
		} catch {
			// pi.events may be unavailable on older hosts or lightweight mocks.
		}
	})

	pi.on("session_shutdown", (_event, ctx) => {
		// Scoped to the shutting-down session only — concurrent sessions on
		// multi-session hosts (ACP) keep their trackers and counters. Runs before
		// the outcome watcher's shutdown expiry (registration order), so an
		// id-less watch's terminal "expired" outcome loses fallback attribution —
		// fine: every production watch passes the fire's steer_id.
		const sessionId = ctx.sessionManager.getSessionId()
		lastSteerFiredBySession.delete(sessionId)
		lastFireBySessionKind.delete(sessionId)
		turnCountBySession.delete(sessionId)
	})
}
