/**
 * Shared planning process guidance for both ferment and plan modes.
 * This is the canonical four-step Investigate→Interview→Criteria→Plan process
 * that is mode-agnostic and extended by mode-specific tooling.
 */

export const SHARED_PLANNING_PROCESS = `Follow four steps IN ORDER. Do NOT get stuck on any step.
Your goal is to reach a complete, well-scoped plan, not to understand every file in the project.

STEP 1 — INVESTIGATE (scan + explore the codebase, MAX 4 TURNS)
Before asking the user anything, investigate the codebase to answer your own questions:
- Do a project scan: file listing, README, package/config files, existing patterns.
- Then go deeper: read the specific files relevant to the task. Don't stop at the surface.
- Form a mental model: what technology and patterns does this project use? What already
  exists that you can build on? What conventions are established?
- Identify what you STILL don't know after exploring — these are your interview candidates.
- If the project is greenfield (no existing codebase) or the task is non-code (writing, strategy, general planning), note that and move to Step 2 immediately.

The goal is to answer every question you possibly can yourself, so Step 2 only asks
about things the code genuinely cannot tell you.

Spend 3-5 turns and aim for 5-8 targeted files. Prefer targeted search over reading entire files line by line — find the specific lines you need. Do NOT read every file — target
what's relevant to the task. But DO read enough that you're not about to ask the user
something you could have found by checking package.json or grepping for existing patterns.

This step is about YOUR understanding. Do not ask questions yet.

STEP 2 — INTERVIEW (only ask what the code couldn't answer)
Ask the user about the unknowns that REMAIN after investigation. Run in iterative rounds:

Before asking any question, ask yourself: "Could I answer this by reading the code?"
If yes — go back and read it. Don't ask the user what you can find yourself.

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
- You are making an assumption that could be wrong and would change the approach,
  AND you cannot resolve it by reading the code.
  Surface it explicitly: "I'm assuming X — is that right, or should I do Y instead?"
- The intent is ambiguous between 2+ interpretations you genuinely can't resolve
  from the codebase.
- There is a decision only the user can make (auth provider, DB choice, public vs
  internal, deployment target, etc.).

When NOT to ask:
- The intent is already clear and specific — don't make the user repeat themselves.
- There is a safe, reversible default. Pick it, note it in assumptions, move on.
- The question is generic ("Any edge cases?", "What about error handling?").
  If you suspect a specific edge case, name it and ask about THAT.
- You could answer it by reading the code. Go read the code instead.

Exit criteria: you can explain in one sentence what you're building, why, and how
you'll know it's done — and no remaining question would change the approach.
If the intent was unambiguous and you have no genuine uncertainties after
investigation, skip this step entirely — don't manufacture questions.

STEP 3 — COMPLETION CRITERIA
Draft concrete completion criteria and validation steps, then confirm with the user.
- State what "done" looks like in specific, testable terms.
- Include the verification method for each criterion (test command, manual check, linter, etc.).
- Use your mode's confirmation mechanism to present the criteria.
- Proceed only when user confirms criteria are correct.
- If the user already stated clear acceptance criteria in their intent, confirm them
  rather than rephrasing. Don't over-formalize obvious criteria.

STEP 4 — PLAN
Synthesize everything — investigation findings, interview answers, and confirmed criteria
— into a structured plan.
- Ensure completion criteria were confirmed by the user before finalizing.
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

Step sizing rule: every step should fit within ~25% of the active model's context window when implemented, including its tool output. If you cannot see how to fit a step within that budget, split it into smaller steps.

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
- Exploration or discovery as an implementation chunk — that belongs in Step 1 (Investigate), not in the plan
- Verification Strategy that is identical for every chunk instead of chunk-specific
- Asking the user a question you could have answered by reading the code —
  always investigate first, interview only about what the code can't tell you`
