/**
 * Bundled behaviour registry.
 *
 * Each entry pairs a markdown body (imported as text by Bun's bundler) with
 * its kind — `baseline` bodies merge into the system prompt unconditionally,
 * `triggered` bodies stay dormant until their triggers fire.
 *
 * The IIFE at module load validates the registry: every body parses, every
 * name is unique. Adding a new behaviour requires only appending another
 * `BehaviourSource` entry below.
 */

import ghCliBody from "./bodies/gh-cli.md" with { type: "text" }
import gitHygieneBody from "./bodies/git-hygiene.md" with { type: "text" }
import { parseBehaviourBody } from "./frontmatter.js"
import { bashStartsWith, fetchesHost } from "./matchers.js"
import { any, cli, gitRemote } from "./triggers.js"
import type { Behaviour, BehaviourEvals, BehaviourKind, BehaviourTriggers } from "./types.js"

interface BehaviourSource {
	raw: string
	kind: BehaviourKind
	triggers?: BehaviourTriggers
	evals?: BehaviourEvals
}

const ghInvocation = bashStartsWith("gh")
const githubFromOtherTool = fetchesHost(/(api\.)?github\.com/)

const sources: BehaviourSource[] = [
	{ raw: gitHygieneBody, kind: "baseline" },
	{
		raw: ghCliBody,
		kind: "triggered",
		triggers: {
			session: any(cli("gh"), gitRemote("github.com")),
			tool: ghInvocation,
		},
		evals: {
			observed: ghInvocation,
			violated: githubFromOtherTool,
		},
	},
]

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
})()
