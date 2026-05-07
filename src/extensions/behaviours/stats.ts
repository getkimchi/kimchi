/**
 * Stats writer — defines the behaviour-related custom JSONL entry types
 * appended via `pi.appendEntry`. Four entry types:
 *
 * - `behaviour_loaded` and `behaviour_eval` are per-event.
 * - `behaviour_requeued` fires once per compaction per behaviour, signalling
 *   that the body was re-injected after summarisation replaced it.
 * - `behaviour_session_summary` is emitted once on `session_shutdown` and
 *   carries the uncapped per-behaviour totals so cross-session aggregation is
 *   a single jq pass.
 */

import type { EvalVerdict, TriggerSource } from "./types.js"

export const BEHAVIOUR_LOADED_TYPE = "behaviour_loaded"
export const BEHAVIOUR_EVAL_TYPE = "behaviour_eval"
export const BEHAVIOUR_REQUEUED_TYPE = "behaviour_requeued"
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

export interface BehaviourRequeuedData {
	name: string
	turnIndex: number
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
