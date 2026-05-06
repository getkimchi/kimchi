/**
 * Behaviour shape for the bundled-behaviours extension.
 *
 * Phase 2 carries baseline metadata plus optional session-probe triggers.
 * Tool-call matchers and evaluator slots are added in later phases without
 * changing the file layout.
 */

import type { SessionProbe } from "./triggers.js"

export type BehaviourKind = "baseline" | "triggered"
export type TriggerSource = "session" | "tool"

export interface BehaviourTriggers {
	session?: SessionProbe
}

export interface Behaviour {
	name: string
	description: string
	body: string
	kind: BehaviourKind
	triggers?: BehaviourTriggers
}
