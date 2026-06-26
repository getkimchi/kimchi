import type { Phase } from "../types.js"

export const DEFAULT_EXPLORE_GUIDELINES = `During **explore** phase:
- Goal: build a mental map, not a solution. Do NOT modify files. Do NOT write a plan yet.
- **Skip explore for greenfield projects** (empty directory, no existing code). There is nothing to explore — proceed directly to plan. A trivial 1-turn explore that only runs \`ls\` on an empty directory wastes a turn and adds no value.
- Start broad with \`grep\`/\`find\`/\`ls\`; then \`read\` the 3–5 most relevant files in full.
- Trace imports and call chains across module boundaries — note the actual entry points and seams, not every file you saw.
- Batch independent reads in a single turn to minimise round-trips.
- **Hypothesis testing**: After 5 consecutive read-only turns without a concrete hypothesis, state your hypothesis and run ONE targeted command to test it. Exploration without a hypothesis wastes tokens.
- Stop as soon as you have enough context to plan. Over-exploring wastes tokens.
- Output: a tight summary (paths, key types, integration points) — what matters, not everything you saw.`

export const DEFAULT_RESEARCH_GUIDELINES = `During **research** phase:
- \`web_search\` is available to ALL models regardless of tier or roles. Prefer it over delegating a simple lookup.
- Run AT MOST one \`web_search\` per task. Do not re-search to "verify" — pick the best query the first time.
- Skip web research for well-known patterns, standard algorithms, or common library APIs you already know.
- Prefer primary sources (official docs, GitHub READMEs, RFCs). Avoid \`web_fetch\` unless the page is unindexed or the user gave a specific URL.
- If research output is non-trivial (more than one fact), save a short markdown note to the Documents directory and reference it from the next phase.`

export const DEFAULT_PLAN_GUIDELINES = `During **plan** phase:
- Design BEFORE coding: file paths, interfaces, function signatures, data flow.
- Save the spec as a markdown file in the Documents directory. The build phase reads from there — do not redo discovery in build.
- Use the standard plan structure: Goal, Constraints, Chunks (with Files Changed, Depends On, Accept When, Test Coverage, Open Questions), Verification Strategy, Decision Log, Risks.
- Every chunk must list concrete file paths in Files Changed — not globs, not vague descriptions. Interfaces and file paths beat prose.
- Identify test files that need creation or update in each chunk's Test Coverage field.
- Call out non-obvious decisions and the alternatives you rejected in the Decision Log.
- Keep the spec focused. Long plans waste downstream tokens.
- **Plan self-validation**: After writing the spec, re-read it and cross-check: does every chunk have concrete file paths? Are Accept When criteria testable and specific? Are there implicit assumptions not in the Decision Log? Fix gaps before submitting.
- **Plan verification (complex tasks only)**: If the plan is complex (3+ files, new architecture, unclear requirements, or any uncertainty), have a different model with \`plan\` or \`review\` strength verify the spec before build. See the orchestration instructions for skip/verify criteria and verifier selection.`

/** Co-author trailer appended to every commit message. Defined once here so
 *  it can be referenced consistently from any guideline that mentions commits. */
export const KIMCHI_COAUTHOR = "Co-Authored-By: Kimchi <noreply@kimchi.dev>"

export const DEFAULT_BUILD_GUIDELINES = `During **build** phase:
- Read each file BEFORE modifying it. Never edit blind.
- Batch independent tool calls in a single turn — fewer turns = less context accumulation.
- Prefer \`edit\` over \`write\` for files >30 lines. Reserve \`write\` for new files or full rewrites.
- Stay in scope: do NOT add features, refactors, or "improvements" beyond what the spec asks for.
- If the same code pattern is needed >2 times, extract an abstraction first instead of duplicating.
- After each meaningful change, run the type-checker / linter / tests. Fix errors before moving on.
- Always wrap shell commands with a timeout to prevent hanging. Use language-native timeouts where available (e.g. \`go test -timeout 60s\`, \`pytest --timeout=60\`, \`jest --testTimeout=60000\`) and \`timeout <seconds> <command>\` for everything else (e.g. \`timeout 30 go run .\`, \`timeout 60 ./server\`). Default to 60 seconds unless the task explicitly requires longer.
- If a tool call fails, diagnose the root cause before retrying — do not retry blindly.
- Keep diffs minimal and reviewable.
- **Git commits**: Always end every commit message with a blank line followed by \`${KIMCHI_COAUTHOR}\`.`

export const DEFAULT_REVIEW_GUIDELINES = `During **review** phase:
- Read the diff or changed files first; then read the surrounding context for any touched function.
- Prioritise: correctness bugs > security issues > architectural concerns > edge cases > style. Skip nits.
- Be specific: quote the exact line and propose the concrete fix.
- Flag missing tests for behaviour the diff introduces or changes.
- **Do NOT modify source files.** Do not apply fixes, do not refactor, do not commit changes. Your job is to report findings — never to act on them. The author or a separate build agent applies fixes.`

export const DEFAULT_PHASE_GUIDELINES: Readonly<Record<Phase, string>> = {
	explore: DEFAULT_EXPLORE_GUIDELINES,
	research: DEFAULT_RESEARCH_GUIDELINES,
	plan: DEFAULT_PLAN_GUIDELINES,
	build: DEFAULT_BUILD_GUIDELINES,
	review: DEFAULT_REVIEW_GUIDELINES,
}
