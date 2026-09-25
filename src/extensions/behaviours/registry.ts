/**
 * Bundled behaviour registry.
 *
 * Each entry pairs a markdown body (imported as text by Bun's bundler) with
 * its kind — `baseline` bodies merge into the system prompt unconditionally,
 * `triggered` bodies stay dormant until their triggers fire.
 *
 * `buildBehaviours` validates the registry at module load: every body parses,
 * every name is unique, every triggered source has at least one trigger.
 * Adding a new behaviour requires only appending another `BehaviourSource`
 * entry below.
 */

import gitHygieneBody from "./bodies/git-hygiene.md" with { type: "text" }
import pythonEditBody from "./bodies/python-edit.md" with { type: "text" }
import reReadBeforeEditBody from "./bodies/re-read-before-edit.md" with { type: "text" }
import { type BehaviourSource, buildBehaviours } from "./build.js"
import { any, gitRepo, tool } from "./triggers.js"
import type { Behaviour } from "./types.js"

const pythonFileEdit = any(
	tool("edit", (i) => i.path.endsWith(".py")),
	tool("write", (i) => i.path.endsWith(".py")),
)

const sources: BehaviourSource[] = [
	{
		raw: gitHygieneBody,
		kind: "triggered",
		triggers: { session: gitRepo() },
	},
	{
		raw: pythonEditBody,
		kind: "triggered",
		triggers: { tool: pythonFileEdit },
	},
	{ raw: reReadBeforeEditBody, kind: "baseline" },
]

// gh-cli / glab-cli were moved out of the conditional prompt into bundled
// skills (resources/skills/{gh-cli,glab-cli}/SKILL.md, bodies verbatim):
// the CLI reference enters context only when the agent reads the skill,
// not eagerly on every github/gitlab session.

export const behaviours: readonly Behaviour[] = buildBehaviours(sources)
