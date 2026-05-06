/**
 * Bundled behaviour registry.
 *
 * Each entry pairs a markdown body (imported as text by Bun's bundler) with
 * its kind — `baseline` bodies merge into the system prompt unconditionally,
 * `triggered` bodies stay dormant until phases 2+ wire trigger evaluation.
 *
 * The IIFE at module load validates the registry. Adding a new behaviour
 * requires only appending another `{ raw, kind }` entry below.
 */

import gitHygieneBody from "./bodies/git-hygiene.md" with { type: "text" }
import { parseBehaviourBody } from "./frontmatter.js"
import type { Behaviour, BehaviourKind } from "./types.js"

interface BehaviourSource {
	raw: string
	kind: BehaviourKind
}

const sources: BehaviourSource[] = [{ raw: gitHygieneBody, kind: "baseline" }]

export const behaviours: readonly Behaviour[] = (() => {
	const result: Behaviour[] = []
	const seen = new Set<string>()
	for (const src of sources) {
		const parsed = parseBehaviourBody(src.raw)
		const { name, description } = parsed.frontmatter
		if (seen.has(name)) {
			throw new Error(`duplicate bundled behaviour name: ${name}`)
		}
		seen.add(name)
		result.push({ name, description, body: parsed.content, kind: src.kind })
	}
	return result
})()
