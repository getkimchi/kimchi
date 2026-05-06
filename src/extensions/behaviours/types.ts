/**
 * Behaviour shape for the bundled-behaviours extension.
 *
 * Phase 1 carries only what the baseline-merge path needs. Triggers and
 * evaluators are added in later phases without changing the file layout.
 */
export type BehaviourKind = "baseline" | "triggered"

export interface Behaviour {
	name: string
	description: string
	body: string
	kind: BehaviourKind
}
