/**
 * Ferment delegation mode.
 *
 * `strict` — the planner delegates every step to a subagent worker.
 * `relaxed` — the planner executes steps directly and delegates only
 * residue-heavy ones, because direct execution measured faster at bench scale.
 *
 * The mode follows multi-model configuration: a single-model session has no
 * separate worker model to delegate to, so it does the work itself.
 *
 * This lives in one place because both the planner prompts and the
 * orchestrator write guard must agree on it — a prompt that says "execute
 * directly" alongside a guard that blocks direct edits is a contradiction the
 * model cannot resolve.
 */
export type FermentDelegationMode = "strict" | "relaxed"

export function fermentDelegationMode(multiModelEnabled: boolean): FermentDelegationMode {
	return multiModelEnabled ? "strict" : "relaxed"
}

/** True when the planner is expected to delegate rather than implement. */
export function fermentDelegationIsStrict(multiModelEnabled: boolean): boolean {
	return fermentDelegationMode(multiModelEnabled) === "strict"
}
