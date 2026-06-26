import type { Phase } from "../types.js"

export const DEFAULT_EXPLORE_GUIDELINES = `During **explore** phase:
- Goal: build a mental map, not a solution. Do NOT modify files. Do NOT write a plan yet.
- **Skip explore for greenfield projects** (empty directory, no existing code). There is nothing to explore — proceed directly to plan. A trivial 1-turn explore that only runs \`ls\` on an empty directory wastes a turn and adds no value.
- Start broad with \`grep\`/\`find\`/\`ls\`; then \`read\` the 3–5 most relevant files in full.
- Trace imports and call chains across module boundaries — note the actual entry points and seams, not every file you saw.
- If you encounter an unfamiliar library, tool, file format, or config schema — or a familiar one whose version or current practice you are assuming (language runtime version, build-tool default, framework convention) — run ONE targeted \`web_search\` (or switch to \`research\` phase) before forming a hypothesis. "I know this" is not the same as "this is current"; stale version assumptions (e.g. defaulting to an older language/runtime version on a greenfield task) are as dangerous as unknown ones.
- When the task names a specific library, framework, build tool, vendor kit, or protocol you will rely on, run ONE targeted \`web_search\` to confirm the version, install steps, or protocol details before you act. Treat named third-party dependencies as suspect until confirmed, even if they feel familiar.
- Batch independent reads in a single turn to minimise round-trips.
- **Hypothesis testing**: After 5 consecutive read-only turns without a concrete hypothesis, state your hypothesis and run ONE targeted command to test it. Exploration without a hypothesis wastes tokens.
- Stop as soon as you have enough context to plan. Over-exploring wastes tokens.
- Output: a tight summary (paths, key types, integration points) — what matters, not everything you saw.`

export const DEFAULT_RESEARCH_GUIDELINES = `During **research** phase:
- Use \`web_search\` when your knowledge might be stale. Triggers: a library/framework version you are assuming but have not verified; an API you are not 100% sure exists in the version in use; an error message or behaviour you do not recognise; a "best practice" claim that may be more than ~18 months old; breaking changes, deprecations, or new runtime/build-tool defaults.
- Do not rely on training memory for the specifics of named libraries, kits, or old framework versions. If the task names a version, vendor, or exact product, verify it before you use it.
- Prefer \`web_search\` over delegating a simple lookup. Prefer primary sources (official docs, GitHub READMEs, RFCs). Then use \`web_fetch\` on the primary source to confirm details, especially for official docs, changelogs, migration guides, or GitHub source files.
- If research output is non-trivial (more than one fact), save a short markdown note to the Documents directory and reference it from the next phase.
- Graceful degradation: if \`web_search\` and \`web_fetch\` are not available in your tool list, do not bluff. State the version/API assumption you are relying on explicitly and ask the user to confirm it before continuing.`

export const DEFAULT_PLAN_GUIDELINES = `During **plan** phase:
- Design BEFORE coding: file paths, interfaces, function signatures, data flow.
- Save the spec as a markdown file in the Documents directory. The build phase reads from there — do not redo discovery in build.
- Use the standard plan structure: Goal, Constraints, Chunks (with Files Changed, Depends On, Accept When, Test Coverage, Open Questions), Verification Strategy, Decision Log, Risks.
- Every chunk must list concrete file paths in Files Changed — not globs, not vague descriptions. Interfaces and file paths beat prose.
- Identify test files that need creation or update in each chunk's Test Coverage field.
- Call out non-obvious decisions and the alternatives you rejected in the Decision Log.
- Any library, runtime, or build-tool version assumption in the plan must either be verified with \`web_search\`/\`web_fetch\` or recorded as an explicit assumption in the Decision Log with a request for user confirmation. Do not let stale knowledge become an implicit plan dependency.
- If the plan depends on any named third-party library, kit, or tool, you must either cite a verified source or run \`web_search\`/\`web_fetch\` to confirm the specifics. "I remember this" is not a source.
- Keep the spec focused. Interfaces and file paths beat prose. Long plans waste downstream tokens.
- **Plan self-validation**: After writing the spec, re-read it in a separate turn and cross-check every requirement. Flag gaps — missing features, ambiguous API choices, unhandled edge cases. This is a lightweight self check; it does not replace external verification for complex tasks.
- **Plan verification (complex tasks only)**: If the plan is complex (3+ files, new architecture, unclear requirements, or any uncertainty), have a different model with \`plan\` or \`review\` strength verify the spec before build. See the orchestration instructions for skip/verify criteria and verifier selection.`

/** Co-author trailer appended to every commit message. Defined once here so
 *  it can be referenced consistently from any guideline that mentions commits. */
export const KIMCHI_COAUTHOR = "Co-Authored-By: Kimchi <noreply@kimchi.dev>"

export const DEFAULT_BUILD_GUIDELINES = `During **build** phase:
- Read a file before modifying it — unless the orchestrator already provided its contents and path in the task spec, in which case you may proceed directly to editing.
- Batch independent tool calls in a single turn — fewer turns = less context accumulation.
- Prefer \`edit\` over \`write\` for files >30 lines. Reserve \`write\` for new files or full rewrites.
- Stay in scope: do NOT add features, refactors, or "improvements" beyond what the spec asks for.
- If the same code pattern is needed >2 times, extract an abstraction first instead of duplicating.
- After each meaningful change, run the type-checker / linter / tests. Fix errors before moving on.
- Always wrap shell commands with a timeout to prevent hanging. Use language-native timeouts where available (e.g. \`go test -timeout 60s\`, \`pytest --timeout=60\`, \`jest --testTimeout=60000\`) and \`timeout <seconds> <command>\` for everything else (e.g. \`timeout 30 go run .\`, \`timeout 60 ./server\`). Default to 60 seconds unless the task explicitly requires longer.
- **Never run interactive commands** (e.g. \`patch -p1\`, \`git rebase\`, \`git commit\`, \`git merge\`, \`git cherry-pick\`, default \`npm init\`). Use non-interactive flags: \`patch --forward\` or \`patch -N\`, \`git -c core.editor=true ...\`, \`GIT_EDITOR=true\`, \`npm init -y\`, \`--yes\`, \`--non-interactive\`. If a command might block on input, redirect stdin from \`/dev/null\` or prefix with \`timeout\`.
- If a tool call fails, diagnose the root cause before retrying — do not retry blindly.
- If you are uncertain about a library API (signature, existence, or current behaviour), run a quick \`web_search\` or ask the user before guessing. A few seconds of research is cheaper than a failed build/test cycle. If web tools are not available, stop and ask rather than bluff.
- If the task names a specific library, framework, build tool, or vendor kit, assume your knowledge may be stale and verify the specific facts (version, API, install step, protocol, current convention) you plan to rely on with a quick \`web_search\`. Do not trust memory just because the name feels familiar. Best practices and defaults (error handling, project layout, testing conventions) drift over time — if your knowledge of a convention is older than ~18 months, verify it before baking it into code.
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
