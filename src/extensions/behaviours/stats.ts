/**
 * Stats writer — defines the behaviour-related custom JSONL entry types
 * appended via `pi.appendEntry`. Three entry types:
 *
 * - `behaviour_loaded` and `behaviour_eval` are per-event.
 * - `behaviour_session_summary` is emitted once on `session_shutdown` and
 *   carries the uncapped per-behaviour totals so cross-session aggregation is
 *   a single jq pass.
 *
 * Bodies persist across turns via the system-prompt block registered for each
 * loaded triggered behaviour, so no per-compaction re-injection entry is
 * needed.
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
