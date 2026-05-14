import { MODEL_CAPABILITIES } from "./builtin-models.js"
import { KIMCHI_DEV_PROVIDER } from "./model-registry.js"
import type { ModelStrength } from "./types.js"

export interface StrengthResolveOptions {
	/** If provided, only IDs in this allowlist are returned (filter to API-available). */
	availableIds?: ReadonlySet<string>
}

/**
 * Return all model entries from MODEL_CAPABILITIES whose `strengths` include
 * the given strength. Returned values are "kimchi-dev/<id>" strings ready to
 * drop into an AgentConfig.models field.
 *
 * Order is the registry's insertion order — NOT a tier ranking. Callers
 * (i.e. the orchestrator LLM) decide which model to pick based on the per-
 * model `tier`/`description` metadata in MODEL_CAPABILITIES, not on position.
 *
 * If `availableIds` is provided, models not in that set are filtered out.
 * "ignored" entries in MODEL_CAPABILITIES are skipped.
 */
export function modelsForStrength(strength: ModelStrength, options: StrengthResolveOptions = {}): string[] {
	const out: string[] = []
	for (const [id, entry] of MODEL_CAPABILITIES.entries()) {
		if (entry === "ignored") continue
		if (!entry.strengths.includes(strength)) continue
		if (options.availableIds && !options.availableIds.has(id)) continue
		out.push(`${KIMCHI_DEV_PROVIDER}/${id}`)
	}
	return out
}

/**
 * Combined strength resolver — returns models that have AT LEAST ONE of the
 * listed strengths, in registry insertion order, deduplicated. Useful for
 * personas that span multiple skill areas. As with `modelsForStrength`,
 * order is not semantic; the calling LLM picks based on capability metadata.
 */
export function modelsForAnyStrength(
	strengths: readonly ModelStrength[],
	options: StrengthResolveOptions = {},
): string[] {
	const want = new Set(strengths)
	const out: string[] = []
	for (const [id, entry] of MODEL_CAPABILITIES.entries()) {
		if (entry === "ignored") continue
		if (!entry.strengths.some((s) => want.has(s))) continue
		if (options.availableIds && !options.availableIds.has(id)) continue
		out.push(`${KIMCHI_DEV_PROVIDER}/${id}`)
	}
	return out
}
