// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
/**
 * Stats writer — defines the behaviour-related custom JSONL entry types
 * appended via `pi.appendEntry`. Three entry types:
 *
 * - `behaviour_loaded` and `behaviour_eval` are per-event.
 * - `behaviour_session_summary` is emitted once on `session_shutdown` and
 *   carries the uncapped per-behaviour totals so cross-session aggregation is
 *   a single jq pass.
 *
 * Bodies persist across turns per delivery class: session-triggered and
 * `standing` bodies via the system-prompt block registered for each loaded
 * triggered behaviour; default tool-triggered bodies via the steer +
 * `session_compact` re-steer path in wiring.ts. No per-compaction re-injection
 * entry type is needed.
 */

import type { EvalVerdict, TriggerSource } from "./types.js"

export const BEHAVIOUR_LOADED_TYPE = "behaviour_loaded"
export const BEHAVIOUR_EVAL_TYPE = "behaviour_eval"
export const BEHAVIOUR_SESSION_SUMMARY_TYPE = "behaviour_session_summary"

export interface BehaviourLoadedData {
	name: string
	trigger: TriggerSource
	turnIndex: number
	toolArgs?: unknown
}

export interface BehaviourEvalData {
	name: string
	verdict: EvalVerdict
	turnIndex: number
	toolName: string
	toolArgs: unknown
}

export interface BehaviourSummaryEntry {
	name: string
	loaded: boolean
	loadedAtTurn?: number
	trigger?: TriggerSource
	observed: number
	violated: number
}

export interface BehaviourSessionSummaryData {
	behaviours: BehaviourSummaryEntry[]
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
