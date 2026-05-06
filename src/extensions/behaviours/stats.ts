/**
 * Stats writer — emits behaviour-related custom JSONL entries via
 * `pi.appendEntry`. Phase 3 emits `behaviour_loaded` and `behaviour_eval`;
 * the per-session summary lands in a later phase.
 */

import type { EvalVerdict, TriggerSource } from "./types.js"

export const BEHAVIOUR_LOADED_TYPE = "behaviour_loaded"
export const BEHAVIOUR_EVAL_TYPE = "behaviour_eval"

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

export type AppendEntry = <T = unknown>(customType: string, data?: T) => void

export function emitBehaviourLoaded(append: AppendEntry, data: BehaviourLoadedData): void {
	append<BehaviourLoadedData>(BEHAVIOUR_LOADED_TYPE, data)
}

export function emitBehaviourEval(append: AppendEntry, data: BehaviourEvalData): void {
	append<BehaviourEvalData>(BEHAVIOUR_EVAL_TYPE, data)
}
