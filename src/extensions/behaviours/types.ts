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
	/** Probe-as-veto for the tool load path only: a tool-matching event loads
	 *  the behaviour only when the gate also passes against the session-start
	 *  `SessionContext`. Unlike `session`, a gate is never a load path on its
	 *  own — `evaluateSessionTriggers` ignores it — so a gated behaviour
	 *  stays dormant at turn 0 in sessions where the gate fails, and still
	 *  loads on tool matches when it passes. Requires `tool` (a gate without
	 *  a tool trigger is meaningless). */
	gate?: SessionProbe
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
	/**
	 * Delivery class for tool-triggered loads — an explicit authoring decision,
	 * never inferred. Default (unset) treats the body as a habit: tool loads are
	 * delivered steer-only (with re-steer after compaction), so the body never
	 * renders late into the system prompt and cannot cause a one-time
	 * full-context cache invalidation. `standing: true` treats the body as
	 * standing policy (e.g. consent rules): the system-prompt block renders on
	 * every load path, accepting that late invalidation in exchange for
	 * front-of-prompt authority.
	 */
	standing?: boolean
}

export type Behaviour = BaselineBehaviour | TriggeredBehaviour
