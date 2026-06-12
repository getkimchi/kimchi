export const SCOPING_EXPLORE_TOKEN_BUDGET = 120_000

export const SCOPING_DISCOVERY_GUIDANCE = `<scoping_sequence required="true">
Scoping follows five steps. Work through them IN ORDER. Do NOT get stuck on any step.
The host monitors your progress and will intervene if you spend too many turns exploring
without advancing. Your goal is to reach propose_ferment_scoping, not to understand
every file in the project.

STEP 1 — ORIENT (lightweight research, MAX 2 TURNS)
Read the user's intent. Before asking anything, build MINIMAL context:
- Do a quick project scan: file listing, README, package/config files (1-2 tool calls).
- Form an initial mental model: what kind of task is this? What technology and patterns?
- Identify your unknowns: what assumptions are you making? What decisions can only the user make?
- If the project is greenfield (no existing codebase), note that and move on immediately.

Default budget: spend about 1-2 turns on Orient and aim for 3-5 targeted files. Exceed this only
for a specific unknown that would materially change the interview questions or plan. Do NOT read
implementation files line by line — save that for Step 4 (Deep Exploration) which happens AFTER
the interview and criteria confirmation. After your initial scan, immediately move to Step 2.

This step is about YOUR understanding, not the user's. Do not ask questions yet.

STEP 2 — INTERVIEW (iterative rounds)
Ask the user about the unknowns you identified in Step 1. Run in rounds:

Round structure:
  a. Ask 1-3 focused questions via ask_user.
     When presenting options, set allowOther: true and include "None of the above"
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
- Use confirm_ferment_completion_criteria to present the criteria. Do not hand-build
  this with ask_user — the host asks one question with two options:
  "Yes, looks good" and "No (input what is wrong)", where "No" includes the
  inline free-form explanation path.
- Proceed only when the tool returns Confirmed: yes and Changes: (none). Otherwise
  revise the criteria and ask again with confirm_ferment_completion_criteria.
- If the user already stated clear acceptance criteria in their intent, confirm them
  rather than rephrasing. Don't over-formalize obvious criteria.
- Confirm criteria with the user before proceeding to exploration.

STEP 4 — DEEP EXPLORATION (targeted, not broad, MAX 2 TURNS of direct reads)
Now investigate the codebase for implementation-specific details.
- Focus ONLY on unknowns that remain after the interview — don't re-explore what you
  already learned in Step 1.
- Prefer spawning Explore subagents over reading files yourself:
  • subagent_type: "Explore" (or closest available)
  • token_budget: ${SCOPING_EXPLORE_TOKEN_BUDGET}
  • run_in_background: true when multiple independent unknowns exist
  • Prefer several narrow probes over one broad "understand everything" scan
- If you read files directly, limit to at most 2 turns of reads. Do not read
  entire implementation files line by line. Use targeted search to find the
  specific lines you need.
- Wait for subagent results before proceeding.
- Skip this step for greenfield tasks with no existing codebase; record why in assumptions.
- If you have enough context from Steps 1-3 to write a plan, skip this step entirely.

STEP 5 — PLAN
Synthesize everything — orient findings, interview answers, confirmed criteria,
and exploration results — into a plan.
- Call propose_ferment_scoping with the complete payload.
- Ensure completion criteria were confirmed with the user before finalizing.
- Default to one phase for simple tasks.
- Add phases only for real vertical slices, different complexity tiers,
  independent workstreams, or distinct code localities.
</scoping_sequence>`
