/**
 * Stats writer — emits behaviour-related custom JSONL entries via
 * `pi.appendEntry`. Phase 2 emits only `behaviour_loaded`; eval verdicts and
 * the per-session summary land in later phases.
 */

import type { TriggerSource } from "./types.js"

export const BEHAVIOUR_LOADED_TYPE = "behaviour_loaded"

export interface BehaviourLoadedData {
	name: string
	trigger: TriggerSource
	turnIndex: number
	toolArgs?: unknown
}

export type AppendEntry = <T = unknown>(customType: string, data?: T) => void

export function emitBehaviourLoaded(append: AppendEntry, data: BehaviourLoadedData): void {
	append<BehaviourLoadedData>(BEHAVIOUR_LOADED_TYPE, data)
}
