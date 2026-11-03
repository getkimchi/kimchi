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

import ghCliBody from "./bodies/gh-cli.md" with { type: "text" }
import gitHygieneBody from "./bodies/git-hygiene.md" with { type: "text" }
import glabCliBody from "./bodies/glab-cli.md" with { type: "text" }
import pythonEditBody from "./bodies/python-edit.md" with { type: "text" }
import reReadBeforeEditBody from "./bodies/re-read-before-edit.md" with { type: "text" }
import { type BehaviourSource, buildBehaviours } from "./build.js"
import { bashInvokes, fetchesHost } from "./matchers.js"
import { any, cli, gitRemote, gitRepo, lspServes, not, tool } from "./triggers.js"
import type { Behaviour } from "./types.js"

const ghInvocation = bashInvokes("gh")
const githubFromOtherTool = fetchesHost(/(api\.)?github\.com/)
const glabInvocation = bashInvokes("glab")
const gitlabFromOtherTool = fetchesHost(/(.+\.)?gitlab\.com/)
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
		triggers: {
			tool: pythonFileEdit,
			// Branch A of LSP-vs-AST-nudge precedence: when the session-start
			// LSP winner serves Python, the lsp-tools system-prompt block has
			// covered validation guidance from turn 0 ("prefer lsp over
			// text-based alternatives") — suppress the AST nudge entirely so no
			// contradictory body is ever steered. Go/TS winners don't serve `py`,
			// so the nudge survives there; lazy mid-session activation (branch B) is
			// handled by the one-time activation steer in the LSP extension.
			gate: not(lspServes("py")),
		},
	},
	{ raw: reReadBeforeEditBody, kind: "baseline" },
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
		// Standing policy: the body carries the consent policy for external /
		// irreversible actions, so it keeps front-of-prompt authority on every
		// load path (block renders even for tool loads) instead of the default
		// steer + re-steer delivery.
		standing: true,
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
		// Standing policy, same rationale as gh-cli (consent rules for
		// external / irreversible actions).
		standing: true,
	},
]

export const behaviours: readonly Behaviour[] = buildBehaviours(sources)
