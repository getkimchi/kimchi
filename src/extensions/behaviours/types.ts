/**
 * Behaviour shape for the bundled-behaviours extension.
 *
 * A behaviour pairs guidance content with the conditions under which it
 * applies. Two trigger slots — `triggers.session` (probes) and `triggers.tool`
 * (matchers) — gate when a triggered behaviour loads. Two evaluator slots —
 * `evals.observed` and `evals.violated` — score post-load tool calls. Both
 * eval slots are restricted to tool matchers at the type level.
 */

import type { SessionProbe, ToolMatcher } from "./triggers.js"

export type BehaviourKind = "baseline" | "triggered"
export type TriggerSource = "session" | "tool"
export type EvalVerdict = "observed" | "violated"

export interface BehaviourTriggers {
	session?: SessionProbe
	tool?: ToolMatcher
}

export interface BehaviourEvals {
	observed?: ToolMatcher
	violated?: ToolMatcher
}

export interface Behaviour {
	name: string
	description: string
	body: string
	kind: BehaviourKind
	triggers?: BehaviourTriggers
	evals?: BehaviourEvals
}
