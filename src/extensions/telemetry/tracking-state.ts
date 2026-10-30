/**
 * Per-session mutable tracking state for telemetry channel handlers.
 *
 * These maps/counts used to live at module scope, which made them process-wide:
 * with concurrent sessions (multi-session ACP host, in-process subagents), one
 * session's ferment timing/token snapshots and bash-guard counters leaked into
 * every other session's records. Each telemetry extension instance now owns
 * one of these objects, created with the instance and cleared on its
 * session_start (via {@link resetFermentTrackingState}) — the same lifecycle as
 * the TelemetryContext it hangs off.
 */

/**
 * Snapshot of cumulative token/cost counters at a point in time.
 * Used to compute per-phase deltas: capture at phase activation,
 * diff at phase completion. Best-effort — inaccurate during true-parallel
 * phases that share the same process-level accumulators.
 */
export interface TokenSnapshot {
	inputByModel: Record<string, number>
	outputByModel: Record<string, number>
	costByModel: Record<string, number>
}

/** All ferment v1 lifecycle tracking maps, keyed as noted per field. */
export interface FermentTrackingState {
	/** Snapshot taken at phase activation, keyed by `${fermentId}:${phaseId}`. */
	phaseTokenSnapshots: Map<string, TokenSnapshot>
	/** Snapshot taken at ferment start for scoping delta computation, keyed by fermentId. */
	scopingTokenSnapshots: Map<string, TokenSnapshot>
	/**
	 * Running sum of phase token/cost deltas, keyed by fermentId.
	 * Accumulated as each phase completes. Used for ferment.completed totals.
	 */
	fermentTokenTotals: Map<string, { input: number; output: number }>
	/** Wall-clock ms at ferment creation, keyed by fermentId. */
	fermentStartTimes: Map<string, number>
	/** Wall-clock ms at phase activation, keyed by `${fermentId}:${phaseId}`. */
	phaseStartTimes: Map<string, number>
	/** Wall-clock ms at step start, keyed by `${fermentId}:${phaseId}:${stepId}`. */
	stepStartTimes: Map<string, number>
	/** User steering interaction count during a ferment, keyed by fermentId. */
	fermentSteeringCounts: Map<string, number>
	/** Steering count snapshot at phase activation, keyed by `${fermentId}:${phaseId}`. */
	phaseSteeringSnapshots: Map<string, number>
	/** Steering count snapshot at step start, keyed by `${fermentId}:${phaseId}:${stepId}`. */
	stepSteeringSnapshots: Map<string, number>
}

/** Bash-tool-guard counters. Per-session (reset at session_start). */
export interface BashGuardCounts {
	warn: number
	block: number
	allowedByUserRequest: number
}

export function createFermentTrackingState(): FermentTrackingState {
	return {
		phaseTokenSnapshots: new Map(),
		scopingTokenSnapshots: new Map(),
		fermentTokenTotals: new Map(),
		fermentStartTimes: new Map(),
		phaseStartTimes: new Map(),
		stepStartTimes: new Map(),
		fermentSteeringCounts: new Map(),
		phaseSteeringSnapshots: new Map(),
		stepSteeringSnapshots: new Map(),
	}
}

/** Reset every tracking map to its initial (empty) state. */
export function resetFermentTrackingState(state: FermentTrackingState): void {
	state.phaseTokenSnapshots.clear()
	state.scopingTokenSnapshots.clear()
	state.fermentTokenTotals.clear()
	state.fermentStartTimes.clear()
	state.phaseStartTimes.clear()
	state.stepStartTimes.clear()
	state.fermentSteeringCounts.clear()
	state.phaseSteeringSnapshots.clear()
	state.stepSteeringSnapshots.clear()
}

/** Delete every tracking entry belonging to one ferment (completion/abandon cleanup). */
export function cleanupFermentTrackingEntries(state: FermentTrackingState, fermentId: string): void {
	state.fermentStartTimes.delete(fermentId)
	state.fermentTokenTotals.delete(fermentId)
	state.fermentSteeringCounts.delete(fermentId)
	state.scopingTokenSnapshots.delete(fermentId)
	for (const key of state.phaseTokenSnapshots.keys()) {
		if (key.startsWith(`${fermentId}:`)) state.phaseTokenSnapshots.delete(key)
	}
	for (const key of state.phaseStartTimes.keys()) {
		if (key.startsWith(`${fermentId}:`)) state.phaseStartTimes.delete(key)
	}
	for (const key of state.stepStartTimes.keys()) {
		if (key.startsWith(`${fermentId}:`)) state.stepStartTimes.delete(key)
	}
	for (const key of state.phaseSteeringSnapshots.keys()) {
		if (key.startsWith(`${fermentId}:`)) state.phaseSteeringSnapshots.delete(key)
	}
	for (const key of state.stepSteeringSnapshots.keys()) {
		if (key.startsWith(`${fermentId}:`)) state.stepSteeringSnapshots.delete(key)
	}
}
