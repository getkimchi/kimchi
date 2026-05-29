import { MODEL_CAPABILITIES } from "./builtin-models.js"
import { KIMCHI_DEV_PROVIDER } from "./model-registry.js"
import type { ModelRole } from "./types.js"

export interface RoleResolveOptions {
	/** If provided, only IDs in this allowlist are returned (filter to API-available). */
	availableIds?: ReadonlySet<string>
}

/**
 * Return all model entries from MODEL_CAPABILITIES whose `roles` include
 * the given role. Returned values are "kimchi-dev/<id>" strings ready to
 * drop into an AgentConfig.models field.
 *
 * Order is the registry's insertion order — NOT a tier ranking. Callers
 * (i.e. the orchestrator LLM) decide which model to pick based on the per-
 * model `tier`/`description` metadata in MODEL_CAPABILITIES, not on position.
 *
 * If `availableIds` is provided, models not in that set are filtered out.
 * "ignored" entries in MODEL_CAPABILITIES are skipped.
 */
export function modelsForRole(role: ModelRole, options: RoleResolveOptions = {}): string[] {
	const out: string[] = []
	for (const [id, entry] of MODEL_CAPABILITIES.entries()) {
		if (entry === "ignored") continue
		if (!entry.roles.includes(role)) continue
		if (options.availableIds && !options.availableIds.has(id)) continue
		out.push(`${KIMCHI_DEV_PROVIDER}/${id}`)
	}
	return out
}

/**
 * Combined role resolver — returns models that have AT LEAST ONE of the
 * listed roles, in registry insertion order, deduplicated. Useful for
 * personas that span multiple skill areas. As with `modelsForRole`,
 * order is not semantic; the calling LLM picks based on capability metadata.
 */
export function modelsForAnyRole(roles: readonly ModelRole[], options: RoleResolveOptions = {}): string[] {
	const want = new Set(roles)
	const out: string[] = []
	for (const [id, entry] of MODEL_CAPABILITIES.entries()) {
		if (entry === "ignored") continue
		if (!entry.roles.some((s) => want.has(s))) continue
		if (options.availableIds && !options.availableIds.has(id)) continue
		out.push(`${KIMCHI_DEV_PROVIDER}/${id}`)
	}
	return out
}
