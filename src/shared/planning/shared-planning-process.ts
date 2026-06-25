/**
 * Shared planning process guidance for both ferment and plan modes.
 * This is the canonical five-step Orient→Interview→Criteria→Explore→Plan process
 * that is mode-agnostic and extended by mode-specific tooling.
 */

export const SHARED_PLANNING_PROCESS = `Follow five steps IN ORDER. Do NOT get stuck on any step.
Your goal is to reach a complete, well-scoped plan, not to understand every file in the project.

STEP 1 — ORIENT (lightweight research, MAX 2 TURNS)
Read the user's intent. Before asking anything, build MINIMAL context:
- Do a quick project scan: file listing, README, package/config files (1-2 tool calls).
- Form an initial mental model: what kind of task is this? What technology and patterns?
- Identify your unknowns: what assumptions are you making? What decisions can only the user make?
- If the project is greenfield (no existing codebase) or the task is non-code (writing, strategy, general planning), note that and move on immediately.

Default budget: spend about 1-2 turns on Orient and aim for 3-5 targeted files. Exceed this only
for a specific unknown that would materially change the interview questions or plan. Do NOT read
implementation files line by line — save that for Step 4 (Deep Exploration) which happens AFTER
the interview and criteria confirmation.

This step is about YOUR understanding, not the user's. Do not ask questions yet.

STEP 2 — INTERVIEW (iterative rounds)
Ask the user about the unknowns you identified in Step 1. Run in rounds:

Round structure:
  a. Ask 1-3 focused questions using your mode's structured Q&A tool.
     When presenting options, allow free-form alternatives and include "None of the above"
     for predefined choices.
  b. When answers come back, REFLECT before continuing:
     - How do these answers change your understanding of the task?
     - Do you need to check anything in the codebase to validate or act on an answer?
       If so, do a quick targeted lookup (grep, short read) — keep it narrow.
     - Does this introduce new assumptions or new questions?
  c. If new questions emerged, ask them in the next round.
  d. If scope is clear and no question would change the approach, exit the loop.

When to ask:
- You are making an assumption that could be wrong and would change the approach.
  Surface it explicitly: "I'm assuming X — is that right, or should I do Y instead?"
- The intent is ambiguous between 2+ interpretations you genuinely can't resolve.
- There is a decision only the user can make (auth provider, DB choice, public vs internal, etc.).

When NOT to ask:
- The intent is already clear and specific — don't make the user repeat themselves.
- There is a safe, reversible default. Pick it, note it in assumptions, move on.
- The question is generic ("Any edge cases?", "What about error handling?").
  If you suspect a specific edge case, name it and ask about THAT.

Exit criteria: you can explain in one sentence what you're building, why, and how
you'll know it's done — and no remaining question would change the approach.
If the intent was unambiguous from Step 1 and you have no genuine uncertainties,
skip this step entirely — don't manufacture questions.

STEP 3 — COMPLETION CRITERIA
Draft concrete completion criteria and validation steps, then confirm with the user.
- State what "done" looks like in specific, testable terms.
- Include the verification method for each criterion (test command, manual check, linter, etc.).
- Use your mode's confirmation mechanism to present the criteria.
- Proceed only when user confirms criteria are correct.
- If the user already stated clear acceptance criteria in their intent, confirm them
  rather than rephrasing. Don't over-formalize obvious criteria.
- Confirm criteria with the user BEFORE proceeding to exploration.

STEP 4 — DEEP EXPLORATION (targeted, not broad, MAX 2 TURNS of direct reads)
Now investigate the codebase for implementation-specific details.
- Focus ONLY on unknowns that remain after the interview — don't re-explore what you
  already learned in Step 1.
- Prefer targeted search over reading entire files line by line. Find the specific
  lines you need.
- If you read files directly, limit to at most 2 turns of reads.
- Skip this step for greenfield tasks with no existing codebase; record why in assumptions.
- Skip entirely if you have enough context from Steps 1-3 to write a plan.
- After exploration, verify your understanding and look for gaps.

STEP 5 — PLAN
Synthesize everything — orient findings, interview answers, confirmed criteria,
and exploration results — into a structured plan.
- Ensure completion criteria were confirmed with the user before finalizing.
- Do NOT finalize the plan while any open question remains unresolved.
- Use your mode's completion mechanism to submit the plan for user review.

Every plan must use this structure:

## Goal
One-sentence statement of what the plan achieves.

## Constraints
List non-negotiable requirements (e.g., "no new dependencies", "preserve existing API").

## Chunks
Ordered, independently-verifiable units of work. Each chunk has:
- **Scope**: what it covers (file paths, components)
- **Files Changed**: every file created, modified, or deleted — use concrete paths, not globs
- **Depends On**: which prior chunk(s) it requires
- **Accept When**: 2-3 concrete, verifiable criteria
- **Test Coverage**: which test files need creation or update for this chunk
- **Open Questions**: explicitly list any unknowns or assumptions (never leave implicit)

## Verification Strategy
How to confirm each chunk is correct (test command, manual check, etc.).

## Decision Log
Tracked choices with rationale and rejected alternatives noted.

## Risks
Named risks with likelihood and mitigation approach.

Assumption rule: you are encouraged to make assumptions when planning — exploration often requires
educated guesses. However, every assumption must be surfaced explicitly and resolved with the user
before the plan is finalized. Add unresolved assumptions to the relevant chunk's Open Questions,
use your mode's Q&A tool to confirm them, then move confirmed ones to the Decision Log.
Do not present the plan as final while any Open Question remains unresolved.

Self-validation: after writing the plan, re-read it and cross-check against the completion criteria.
For each chunk, verify: (1) Files Changed lists concrete paths, not vague descriptions, (2) Accept
When criteria are testable and specific, (3) no implicit assumptions remain unrecorded. Flag and
fix any gaps before submitting the plan for review.

Common plan anti-patterns to avoid:
- Chunks that say "refactor X" without listing which files change and how
- Accept When criteria that are just "it works" or "tests pass" without naming the specific test
- Every chunk depending on the previous one when some could be parallel
- Exploration or discovery as an implementation chunk — that belongs in Steps 1/4, not in the plan
- Verification Strategy that is identical for every chunk instead of chunk-specific`
