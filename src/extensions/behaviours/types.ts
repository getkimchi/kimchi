/**
 * Behaviour shape for the bundled-behaviours extension.
 *
 * A behaviour pairs guidance content with the conditions under which it
 * applies. The kind is discriminated:
 *
 * - `baseline` behaviours always merge into the system prompt — they have no
 *   triggers and no evals.
 * - `triggered` behaviours load on demand. They carry a `triggers` slot
 *   (session probe and/or tool matcher) and optional `evals` (`observed` /
 *   `violated` matchers scored after load).
 *
 * The discriminated union keeps the type system honest: triggers/evals are
 * unreachable on baselines, so the compiler refuses to set them.
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

interface BehaviourBase {
	name: string
	description: string
	body: string
}

export interface BaselineBehaviour extends BehaviourBase {
	kind: "baseline"
}

export interface TriggeredBehaviour extends BehaviourBase {
	kind: "triggered"
	triggers: BehaviourTriggers
	evals?: BehaviourEvals
}

export type Behaviour = BaselineBehaviour | TriggeredBehaviour
