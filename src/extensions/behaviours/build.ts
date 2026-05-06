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
import type { Behaviour, BehaviourEvals, BehaviourTriggers } from "./types.js"

interface BaselineSource {
	raw: string
	kind: "baseline"
}

interface TriggeredSource {
	raw: string
	kind: "triggered"
	triggers: BehaviourTriggers
	evals?: BehaviourEvals
}

export type BehaviourSource = BaselineSource | TriggeredSource

/**
 * Parse and validate a list of behaviour sources into a `Behaviour[]`.
 *
 * Throws on duplicate names and on triggered sources whose `triggers` slot is
 * empty (no session probe and no tool matcher — such a behaviour would be
 * unreachable). Pure over its inputs.
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
		if (src.kind === "baseline") {
			result.push({ kind: "baseline", name, description, body: parsed.content })
			continue
		}
		if (!src.triggers.session && !src.triggers.tool) {
			throw new Error(`triggered behaviour ${name} has no session or tool trigger`)
		}
		result.push({
			kind: "triggered",
			name,
			description,
			body: parsed.content,
			triggers: src.triggers,
			evals: src.evals,
		})
	}
	return result
}
