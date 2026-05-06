import type { Phase } from "../model-registry/types.js"

export const DEFAULT_PHASE_GUIDELINES: Readonly<Record<Phase, string>> = {
	explore: `During **explore** phase:
- Read files broadly before diving deep. Trace imports and call chains.
- Use \`grep\` and \`find\` to locate relevant files quickly.
- Do NOT modify files. Do NOT write plans yet. Gather context only.
- Summarize findings concisely — what matters, not everything you saw.`,

	research: `During **research** phase:
- Use \`web_search\` for external facts, API docs, library versions.
- Run at most ONE web_search per task. Prefer primary sources.
- Skip web research for well-known patterns, common APIs, standard algorithms.
- Synthesize findings into a short markdown note in the Documents directory.`,

	plan: `During **plan** phase:
- Design interfaces and file structure before writing code.
- Save the spec to the Documents directory as a markdown file.
- Identify all files that will be touched. Show file paths clearly.
- List test files that need updating or creation.
- Only start build once the plan is written and saved.`,

	build: `During **build** phase:
- Batch independent tool calls in the same response. Fewer turns = better.
- Prefer \`edit\` over \`write\` for files >30 lines.
- Read files before modifying them. Do NOT add features beyond what was asked.
- If the same pattern is needed >2 times, define an abstraction first.
- Run tests after changes. Fix errors before declaring done.`,

	review: `During **review** phase:
- Read the diff (or changed files) first, then full file context for touched lines.
- Flag architectural concerns, edge cases, and security issues — not just typos.
- Be specific: quote the line and suggest the fix.
- Do NOT rewrite code inline unless asked. Report findings and let the author fix.`,
}
