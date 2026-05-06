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

import boundToolOutputBody from "./bodies/bound-tool-output.md" with { type: "text" }
import ghCliBody from "./bodies/gh-cli.md" with { type: "text" }
import gitHygieneBody from "./bodies/git-hygiene.md" with { type: "text" }
import glabCliBody from "./bodies/glab-cli.md" with { type: "text" }
import pythonEditBody from "./bodies/python-edit.md" with { type: "text" }
import { type BehaviourSource, buildBehaviours } from "./build.js"
import { bashInvokes, fetchesHost } from "./matchers.js"
import { any, cli, gitRemote } from "./triggers.js"
import type { Behaviour } from "./types.js"

const ghInvocation = bashInvokes("gh")
const githubFromOtherTool = fetchesHost(/(api\.)?github\.com/)
const glabInvocation = bashInvokes("glab")
const gitlabFromOtherTool = fetchesHost(/(.+\.)?gitlab\.com/)

const sources: BehaviourSource[] = [
	{ raw: gitHygieneBody, kind: "baseline" },
	{ raw: pythonEditBody, kind: "baseline" },
	{ raw: boundToolOutputBody, kind: "baseline" },
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
	{
		raw: glabCliBody,
		kind: "triggered",
		triggers: {
			session: any(cli("glab"), gitRemote("gitlab.com")),
			tool: glabInvocation,
		},
		evals: {
			observed: glabInvocation,
			violated: gitlabFromOtherTool,
		},
	},
]

export const behaviours: readonly Behaviour[] = buildBehaviours(sources)
