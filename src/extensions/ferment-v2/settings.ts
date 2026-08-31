/**
 * User-adjustable Ferment V2 policy stored under the "Ferment V2" settings key.
 * Values are read fresh; the "judge" model role remains the evaluator source
 * of truth, so this module does not define a second model override.
 */

import { readConfigSetting } from "../../config/settings.js"

export interface FermentV2Settings {
	/** Whether to auto-queue a continuation turn for a resumed active Ferment V2 on session_start. */
	autoResume: boolean
	/** Consecutive no-progress continuation turns before the Ferment V2 pauses itself. */
	maxUnchangedContinuations: number
	/** Consecutive agent-error turns before the Ferment V2 pauses itself. */
	maxConsecutiveErrors: number
	/** Token budget applied to `/ferment-v2 <objective>` when the user didn't pass `--tokens`. Unset by default. */
	defaultTokenBudget: number | undefined
	/** How long the evaluator call is allowed to run before it's treated as unavailable. */
	evaluationTimeoutMs: number
}

export const DEFAULT_FERMENT_V2_SETTINGS: Readonly<FermentV2Settings> = {
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
 * Validate a raw "Ferment V2" settings value against defaults. Each field is
 * checked independently, so one malformed field falls back to its default
 * without discarding the others -- and a non-object `raw` (or none at all)
 * simply yields all defaults.
 */
export function parseFermentV2Settings(raw: unknown): FermentV2Settings {
	const settings: FermentV2Settings = { ...DEFAULT_FERMENT_V2_SETTINGS }
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
 * Resolve the effective Ferment V2 settings from settings.json, merged with
 * defaults. No caching (see header) -- evaluateFermentV2 runs at most once per
 * settled turn and everything else here runs at most once per turn, so a
 * fresh read each time is not a meaningful cost.
 */
export function getFermentV2Settings(): FermentV2Settings {
	const raw = readConfigSetting("fermentV2", isPlainObject)
	return parseFermentV2Settings(raw)
}
