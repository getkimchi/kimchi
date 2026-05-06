/**
 * Pure builder for the bundled behaviour registry — no markdown imports here
 * so it can be loaded by vitest without a `.md` text-import plugin.
 *
 * `registry.ts` declares the bundled sources (which do import markdown bodies
 * via Bun text imports) and feeds them through `buildBehaviours` exactly
 * once at module load. The same function is exercised by the registry test
 * suite against synthetic sources to verify the duplicate-name and
 * malformed-body contracts.
 */

import { parseBehaviourBody } from "./frontmatter.js"
import type { Behaviour, BehaviourEvals, BehaviourKind, BehaviourTriggers } from "./types.js"

export interface BehaviourSource {
	raw: string
	kind: BehaviourKind
	triggers?: BehaviourTriggers
	evals?: BehaviourEvals
}

/**
 * Parse and validate a list of behaviour sources into a `Behaviour[]`.
 *
 * Throws on duplicate names. Pure over its inputs.
 */
export function buildBehaviours(sources: readonly BehaviourSource[]): Behaviour[] {
	const result: Behaviour[] = []
	const seen = new Set<string>()
	for (const src of sources) {
		const parsed = parseBehaviourBody(src.raw)
		const { name, description } = parsed.frontmatter
		if (seen.has(name)) {
			throw new Error(`duplicate bundled behaviour name: ${name}`)
		}
		seen.add(name)
		result.push({
			name,
			description,
			body: parsed.content,
			kind: src.kind,
			triggers: src.triggers,
			evals: src.evals,
		})
	}
	return result
}
