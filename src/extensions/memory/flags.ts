/**
 * One parser for every memory-lane env flag. Two grammars exist:
 * truthy-style (any non-empty/non-"0"/non-"false" value) for shipped lanes,
 * and strict-"1" for spike-grade lanes that must not light up on a stray
 * truthy assignment (e.g. a CI matrix var set to "yes"). Callers pass
 * strict: true for the latter; if a strict lane graduates to shipped
 * status, flip its call site, not this file.
 *
 * Pure — unit-testable under Node. Reads only the supplied env map.
 */

export interface BooleanFlagOptions {
	/** When true, only the literal "1" enables the lane. */
	strict?: boolean
}

export function parseBooleanFlag(env: NodeJS.ProcessEnv, name: string, options: BooleanFlagOptions = {}): boolean {
	const raw = env[name]
	if (options.strict) return raw === "1"
	return raw !== undefined && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false"
}

/** KIMCHI_MEMORY_FACT_CLASSES, truthy grammar — single parse point for capture-worker and inject. */
export function factClassesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return parseBooleanFlag(env, "KIMCHI_MEMORY_FACT_CLASSES")
}

/** KIMCHI_MEMORY_AUTHORED, truthy grammar — single parse point for tools and index. */
export function authoredEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return parseBooleanFlag(env, "KIMCHI_MEMORY_AUTHORED")
}

/**
 * KIMCHI_MEMORY_STALE_AWARE_DIGEST, truthy grammar — swap the digest banner
 * for the stale-aware wording (facts may be out of date; verify before
 * relying). Default OFF keeps the master-era banner byte-identical.
 */
export function staleAwareDigestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return parseBooleanFlag(env, "KIMCHI_MEMORY_STALE_AWARE_DIGEST")
}
