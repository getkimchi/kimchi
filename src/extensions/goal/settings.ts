/**
 * User-adjustable policy knobs for the Goal extension.
 *
 * Stored as a single namespaced object under the "goal" key in
 * ~/.config/kimchi/harness/settings.json — following the same pattern as
 * "modelRoles" (see orchestration/model-roles.ts): one tidy key rather than
 * five top-level ones.
 *
 * Every field is validated independently. A missing key, a malformed "goal"
 * value (wrong type, null, an array, ...), or an individual field with the
 * wrong type/shape (a string where a number belongs, 0, a negative number, a
 * float, null, ...) silently falls back to that field's default — never
 * throws, never crashes the extension, and never lets one bad field discard
 * the others.
 *
 * Read fresh on every call (no caching), matching getMultiModelEnabled's
 * convention: a user editing settings.json takes effect on the next read
 * without restarting.
 *
 * Deliberately NOT included here: an evaluator-model override. The "judge"
 * model role (see orchestration/model-roles.ts, resolveGoalEvaluatorModel in
 * evaluator.ts) already selects the evaluator model; a second knob here would
 * be a second source of truth for the same decision.
 *
 * Example settings.json:
 * ```json
 * {
 *   "goal": {
 *     "autoResume": true,
 *     "maxUnchangedContinuations": 3,
 *     "maxConsecutiveErrors": 3,
 *     "defaultTokenBudget": 200000,
 *     "evaluationTimeoutMs": 30000
 *   }
 * }
 * ```
 */

import { readConfigSetting } from "../../config/settings.js"

export interface GoalSettings {
	/** Whether to auto-queue a continuation turn for a resumed active goal on session_start. */
	autoResume: boolean
	/** Consecutive no-progress continuation turns before the goal pauses itself. */
	maxUnchangedContinuations: number
	/** Consecutive agent-error turns before the goal pauses itself. */
	maxConsecutiveErrors: number
	/** Token budget applied to `/goal <objective>` when the user didn't pass `--tokens`. Unset by default. */
	defaultTokenBudget: number | undefined
	/** How long the evaluator call is allowed to run before it's treated as unavailable. */
	evaluationTimeoutMs: number
}

export const DEFAULT_GOAL_SETTINGS: Readonly<GoalSettings> = {
	autoResume: true,
	maxUnchangedContinuations: 3,
	maxConsecutiveErrors: 3,
	defaultTokenBudget: undefined,
	evaluationTimeoutMs: 30_000,
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean"
}

/** Strictly positive integer: rejects 0, negatives, floats, and non-numbers. */
function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Validate a raw "goal" settings value against defaults. Each field is
 * checked independently, so one malformed field falls back to its default
 * without discarding the others -- and a non-object `raw` (or none at all)
 * simply yields all defaults.
 */
export function parseGoalSettings(raw: unknown): GoalSettings {
	const settings: GoalSettings = { ...DEFAULT_GOAL_SETTINGS }
	if (!isPlainObject(raw)) return settings

	if (isBoolean(raw.autoResume)) settings.autoResume = raw.autoResume
	if (isPositiveInteger(raw.maxUnchangedContinuations))
		settings.maxUnchangedContinuations = raw.maxUnchangedContinuations
	if (isPositiveInteger(raw.maxConsecutiveErrors)) settings.maxConsecutiveErrors = raw.maxConsecutiveErrors
	if (isPositiveInteger(raw.defaultTokenBudget)) settings.defaultTokenBudget = raw.defaultTokenBudget
	if (isPositiveInteger(raw.evaluationTimeoutMs)) settings.evaluationTimeoutMs = raw.evaluationTimeoutMs

	return settings
}

/**
 * Resolve the effective Goal settings from settings.json, merged with
 * defaults. Reads on every call (no caching) so an edited settings.json
 * takes effect without restarting -- evaluateGoal runs at most once per
 * settled turn and everything else here runs at most once per turn, so a
 * fresh read each time is not a meaningful cost.
 */
export function getGoalSettings(): GoalSettings {
	const raw = readConfigSetting("goal", isPlainObject)
	return parseGoalSettings(raw)
}
