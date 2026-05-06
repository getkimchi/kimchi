---
name: full-cycle
description: Complete development cycle from exploration to PR in one command. TDD throughout the implementation phase. Writes a persistent plan file that agents update as they work, so progress survives restarts.
when_to_use: User wants end-to-end delivery in a single invocation — phrases like "build X from scratch", "end to end", "do the whole thing", "explore → implement → review → PR". Also when resuming a previous full-cycle that was interrupted.
allowed-tools: [Task, Bash, Read, Write, Edit]
argument-hint: [task description]
model: kimi-k2.6
effort: high
---

# Full Development Cycle

**Core principle:** One command, full workflow. Explore → Plan → Implement (TDD) → Review → Finish. A plan file on disk is the single source of truth — agents read it, update it, and the workflow can resume from it after any interruption.

<orchestrator_role>
<rule>YOU DO NOT WRITE PRODUCTION CODE YOURSELF.</rule>
<rule>YOU DO NOT WRITE TESTS YOURSELF.</rule>
<rule>YOU DO NOT READ SOURCE FILES YOURSELF.</rule>
<rule>YOU DO NOT RUN TESTS YOURSELF.</rule>
<rule>YOU DELEGATE all product work to agents via the Task tool.</rule>
<rule>You COORDINATE, RELAY, GATE, and MAINTAIN THE PLAN FILE — nothing else.</rule>
<rule>Read/Write/Edit are used ONLY for the plan file at `.claude/full-cycle/plans/&lt;slug&gt;.md`. Never touch source code or tests directly.</rule>
<rule>Bash is ONLY for git commands (git diff, git log, git status, git commit, git push, gh pr) and `date` for timestamps. Never run build, test, install, compile, or tidy commands — delegate to agents.</rule>
<rule>PARALLEL MEANS PARALLEL: When a &lt;dispatch_strategy name="parallel"&gt; block appears, you MUST dispatch ALL agents inside it in a single message with multiple Task tool calls.</rule>
<rule>TDD IS MANDATORY in Phase 4. No production code is written before a failing test exists.</rule>
<rule>Every agent dispatch MUST include the Plan-File Update Contract (see below) so the agent marks its todos.</rule>
<rule>When an agent returns with errors, build failures, or warnings — dispatch another agent (expert-coder or debugger) to fix them. NEVER fix issues yourself.</rule>
</orchestrator_role>

<plan_file>
<path>`.claude/full-cycle/plans/&lt;slug&gt;.md`</path>
<slug_rules>Derive from the task description: lowercase, kebab-case, strip articles, first 40 chars. Ask the user if ambiguous.</slug_rules>
<purpose>Single source of truth for a full-cycle run. Survives restarts. Agents update todos as they progress.</purpose>

<schema>

```markdown
---
task: <Human-readable title>
slug: <kebab-case-slug>
status: exploring | planning | awaiting-plan-approval | implementing | awaiting-tests-confirm | reviewing | awaiting-review-confirm | finishing | done | blocked
started_at: <ISO-8601>
updated_at: <ISO-8601>
current_phase: 1 | 2 | 3 | 4 | 5 | 6
current_item: <id of TDD work item in progress, or null>
---

# <Task Title>

## Original Request
<verbatim from the user>

## Phase 1 — Exploration
Status: [ ] pending | [~] in-progress | [x] done

### Findings Summary
<filled after Explore agents return>

### Relevant Files
<file list, patterns, constraints>

---

## Phase 2-3 — Plan & Architecture Review
Status: [ ] pending | [~] in-progress | [x] done

### Implementation Plan
<filled by Plan agent>

### Architecture Feedback
<filled by architecture-analyzer>

### Approved: [ ] pending user approval | [x] approved at <timestamp>

---

## Phase 4 — Implementation (TDD)
Status: [ ] pending | [~] in-progress | [x] done

### TDD Work Items

<!--
Status symbols:
  [ ] pending, [~] in-progress, [x] done, [!] blocked (append a note)
Each work item is one testable behavior. Break broad features into multiple items.
-->

- [ ] Work Item 1: <one-line behavior description>
  - [ ] RED: failing test at <test-path> for <behavior>
  - [ ] GREEN: minimal implementation at <source-paths>
  - [ ] REFACTOR: cleanup at <source-paths>
- [ ] Work Item 2: ...

### Implementation Notes
<freeform, agents append here>

---

## Phase 5 — Review
Status: [ ] pending | [~] in-progress | [x] done

### Review Findings
<filled by code-reviewer>

### Fixes Applied
<filled as fix-cycle iterations complete>

---

## Phase 6 — Finish
Status: [ ] pending | [~] in-progress | [x] done

### Final Validation
<filled by validator>

### Chosen Option
<merge | PR | keep | discard>

---

## History Log
<append-only, one line per phase transition or agent dispatch>
- <ISO timestamp> [phase-N] <what happened>
```

</schema>

<update_protocol>
<step>Orchestrator CREATES the file at Phase 0 if it doesn't exist, after resolving the slug.</step>
<step>If the file already exists, orchestrator offers to RESUME (read `status`, jump to the matching phase) or START-OVER (archive to `.claude/full-cycle/plans/archive/&lt;slug&gt;-&lt;timestamp&gt;.md` and create fresh).</step>
<step>Orchestrator updates the YAML frontmatter `status`, `updated_at`, `current_phase`, `current_item` on every phase transition.</step>
<step>Orchestrator appends to `## History Log` on every dispatch and on every GATE transition.</step>
<step>Agents with Edit (expert-coder, test-writer, debugger, validator) update their assigned work-item todos via the Plan-File Update Contract included in each dispatch.</step>
<step>Agents without Edit (Explore, Plan, architecture-analyzer, code-reviewer, file-mapper) return structured reports; orchestrator transcribes them into the plan file.</step>
</update_protocol>
</plan_file>

<plan_file_update_contract>
Every dispatch prompt MUST end with this block (filled with actual values):

```
---
Plan-File Update Contract (MANDATORY for agents with Edit tool):

Plan file: `.claude/full-cycle/plans/<SLUG>.md`

Before starting work:
1. Read the plan file.
2. Mark your assigned todo(s) as [~] in-progress.
3. Update the YAML `updated_at` to the current ISO timestamp.

When finished:
1. Mark your assigned todo(s) as [x] done (or [!] blocked + one-line reason).
2. Update any filled path placeholders with the real paths (e.g. <test-path> → tests/foo_test.ts:42).
3. Append one line to `## History Log`: `- <ISO timestamp> [<phase>] <agent-name>: <one-line summary>`.
4. Update `updated_at`.

Agents without Edit: skip this contract. The orchestrator will transcribe your report.
---
```
</plan_file_update_contract>

<agent_discovery required="true">
Before doing ANYTHING else, check the Task tool's subagent_type options to see ALL available agents. Print the full list so the user can see what's available.
<agent role="exploration">Explore</agent>
<agent role="planning">Plan</agent>
<agent role="coding">orchestrator-workflows:expert-coder</agent>
<agent role="testing">orchestrator-workflows:test-writer</agent>
<agent role="review">orchestrator-workflows:code-reviewer</agent>
<agent role="validation">orchestrator-workflows:validator</agent>
<agent role="architecture">orchestrator-workflows:architecture-analyzer</agent>
<agent role="debugging">orchestrator-workflows:debugger</agent>
<agent role="file-mapping">orchestrator-workflows:file-mapper</agent>
Map each role to the best matching available agent. Do NOT proceed until discovery is complete.
</agent_discovery>

<todo_setup>
Use TodoWrite to mirror the plan file in your in-session todo list. Phase markers should match the plan file phases:
<task>Step 0: Discover available agents</task>
<task>Step 0b: Resolve slug and create/resume plan file</task>
<task>Phase 1: Explore — dispatch exploration agents</task>
<task>Phase 2: Plan — dispatch planning agent</task>
<task>Phase 3: Validate architecture</task>
<task>GATE: Present plan to user → WAIT for approval</task>
<task>Phase 4: Implement — TDD cycles per work item</task>
<task>GATE: All tests pass → confirm before review</task>
<task>Phase 5: Review — dispatch review agents</task>
<task>GATE: Review approved → confirm before finish</task>
<task>Phase 6: Finish — validator, merge/PR/keep/discard</task>
</todo_setup>

## Phase 0: Slug + Plan File

<step>Derive a slug from the user's task. Print it and ask for confirmation if non-obvious.</step>
<step>Check if `.claude/full-cycle/plans/&lt;slug&gt;.md` exists via Read.</step>
<branch if="file exists">
  <action>Read the file. Show the user the current `status`, `current_phase`, and last 5 History Log lines.</action>
  <action>Ask: "Resume from phase &lt;N&gt; or archive and start over?"</action>
  <branch if="resume">Jump directly to the matching phase below. Skip completed phases.</branch>
  <branch if="archive">Move file to `.claude/full-cycle/plans/archive/&lt;slug&gt;-&lt;timestamp&gt;.md` (Bash mv) and create a fresh plan file.</branch>
</branch>
<branch if="file does not exist">
  <action>Create the plan file using the schema above. Fill `task`, `slug`, `started_at`, `updated_at`, `status: exploring`, `current_phase: 1`, and the `## Original Request` section.</action>
</branch>

## Phase 1: Explore

Update plan file: `status: exploring`, Phase 1 status → `[~]`.

<dispatch_strategy name="parallel" instruction="Send ALL dispatches below as multiple Task tool calls in ONE single message" condition="large or unfamiliar codebase">
<dispatch agent="Explore">Map directory structure, tech stack, entry points, build system for [project].</dispatch>
<dispatch agent="Explore">Find all files related to [user's task]. Map dependencies and data flow.</dispatch>
<dispatch agent="Explore">Find similar implementations and patterns in the codebase that we should follow.</dispatch>
</dispatch_strategy>

<dispatch_strategy name="sequential" condition="small or focused task">
<dispatch agent="Explore">Explore the codebase to understand [user's task]. Find relevant files, patterns, dependencies.</dispatch>
</dispatch_strategy>

After agents return: transcribe findings into `## Phase 1 — Exploration` → `### Findings Summary` + `### Relevant Files`. Mark Phase 1 status `[x]`. Append History Log.

## Phase 2: Plan

Update plan file: `status: planning`, Phase 2-3 status → `[~]`.

<dispatch agent="Plan">
Based on these exploration findings: [paste summary from plan file]. Create an implementation plan for: [user's task]. Include: files to create/modify, step-by-step approach, tests to write, risks, and acceptance criteria.

**Critical:** Break the plan into **TDD work items** — each work item is ONE testable behavior. List them as a numbered sequence. The implementation phase will run Red → Green → Refactor on each item in order.
</dispatch>

After agent returns: transcribe the plan into `### Implementation Plan`, and expand the work-item list into `## Phase 4 — Implementation (TDD) → ### TDD Work Items` using the checklist template. One bullet per work item, with RED/GREEN/REFACTOR sub-bullets.

## Phase 3: Validate Architecture

<dispatch agent="architecture-analyzer">Review this implementation plan against the codebase architecture: [paste plan]. Check: does it follow existing patterns? Any unnecessary complexity? Potential issues?</dispatch>

Transcribe into `### Architecture Feedback`. Mark Phase 2-3 status `[x]`.

<gate id="plan-approval" requires="user_approval">
Update plan file: `status: awaiting-plan-approval`.
<present>Plan file path</present>
<present>Summary of exploration findings</present>
<present>Implementation plan with TDD work items</present>
<present>Architecture feedback</present>
<action>Ask: "Do you approve this plan? Any changes needed?"</action>
<action>DO NOT PROCEED until the user explicitly approves.</action>
<action>On approval: set `### Approved: [x] approved at &lt;timestamp&gt;` and `status: implementing`, append History Log.</action>
</gate>

## Phase 4: Implement — TDD Cycles

**Iron law: no production code without a failing test first.**

Update plan file: `status: implementing`, Phase 4 status → `[~]`.

For each work item in `### TDD Work Items` (in order), run the Red → Green → Refactor sequence. Before each dispatch, update `current_item: &lt;id&gt;` in the YAML frontmatter and mark the relevant sub-todo `[~]`.

### Red — Write a failing test

<dispatch agent="test-writer">
Work Item: {{ITEM_ID}} — {{ITEM_DESCRIPTION}}

Write a test for this behavior. Match the project's existing test framework and patterns (see plan file `### Relevant Files`). The test MUST fail when run — the implementation doesn't exist yet. Run the test and confirm it fails for the RIGHT reason (missing function/class, wrong return value — NOT syntax error).

{{PLAN_FILE_UPDATE_CONTRACT}}
</dispatch>

After agent returns: verify the test fails for the right reason. If it passes immediately, dispatch test-writer again to fix.

<verify_fail_reason>
<ok>Missing function/class</ok>
<ok>Wrong return value</ok>
<not_ok>Test passes immediately — re-dispatch test-writer</not_ok>
<not_ok>Syntax error / import failure — re-dispatch to fix</not_ok>
</verify_fail_reason>

### Green — Make the test pass with minimal code

<dispatch agent="expert-coder">
Work Item: {{ITEM_ID}} — {{ITEM_DESCRIPTION}}

Write MINIMAL code to make this failing test pass:
- Test file: {{TEST_PATH}}
- Target source files: {{SOURCE_PATHS}}

Do not write more than needed. Ugly code is fine at this stage; the next step is refactor. Run the test and confirm it passes. Do NOT modify the test.

{{PLAN_FILE_UPDATE_CONTRACT}}
</dispatch>

After agent returns: verify test passes. If not, dispatch debugger.

### Refactor — Clean up while tests stay green

<dispatch agent="expert-coder">
Work Item: {{ITEM_ID}} — {{ITEM_DESCRIPTION}}

Refactor the code at {{SOURCE_PATHS}}. Improve: readability, naming, remove duplication, match surrounding style. Do NOT change behavior. Run the full test suite after each change — every test MUST still pass.

{{PLAN_FILE_UPDATE_CONTRACT}}
</dispatch>

After all three sub-todos are `[x]`, mark the work item's top-level bullet `[x]` and move to the next item.

<recovery phase="4.1">
<trigger>An agent hits a blocker (test can't be written, fix not obvious, test suite broken globally)</trigger>
<action>Mark the current work item `[!]` and add a one-line reason in `### Implementation Notes`.</action>
<dispatch agent="debugger">Investigate this blocker: [error/issue]. Files involved: [list]. Report root cause and proposed fix.</dispatch>
<action>After debugger reports, decide: dispatch expert-coder with the fix, or escalate to user.</action>
</recovery>

### Parallel TDD (optional)

When multiple work items touch disjoint files, run their Red phases in parallel:

<dispatch_strategy name="parallel" instruction="Send ALL dispatches below as multiple Task tool calls in ONE single message" condition="work items touch disjoint files">
<dispatch agent="test-writer">Work Item A — write failing test. {{PLAN_FILE_UPDATE_CONTRACT}}</dispatch>
<dispatch agent="test-writer">Work Item B — write failing test. {{PLAN_FILE_UPDATE_CONTRACT}}</dispatch>
</dispatch_strategy>

Green and Refactor phases stay sequential per-item to keep the test suite interpretable.

### Phase 4 exit

When every work item's top-level bullet is `[x]`, mark Phase 4 status `[x]`.

<gate id="tests-pass" requires="user_approval">
Update plan file: `status: awaiting-tests-confirm`.
<dispatch agent="validator">Run the full test suite. Verify the implementation matches the plan's work items. Report: pass/fail counts, coverage overview, anything missing. {{PLAN_FILE_UPDATE_CONTRACT}}</dispatch>
<action>Present results to user.</action>
<action>Ask: "All tests pass. Ready for code review?"</action>
<action>DO NOT PROCEED until user confirms.</action>
<action>On confirmation: set `status: reviewing`, append History Log.</action>
</gate>

## Phase 5: Review

Update plan file: Phase 5 status → `[~]`.

<dispatch_strategy name="parallel" instruction="Send ALL dispatches below as multiple Task tool calls in ONE single message" condition="large changes (5+ files)">
<dispatch agent="code-reviewer">Review these changes for correctness and maintainability: [git diff summary]. Focus on bugs, logic errors, readability.</dispatch>
<dispatch agent="code-reviewer">Review these changes for security: [git diff summary]. Focus on injection, auth, secrets, input validation.</dispatch>
<dispatch agent="code-reviewer">Review these changes for performance: [git diff summary]. Focus on N+1 queries, unnecessary allocations, missing indexes.</dispatch>
</dispatch_strategy>

<dispatch_strategy name="sequential" condition="small changes">
<dispatch agent="code-reviewer">Review these changes: [git diff summary].</dispatch>
</dispatch_strategy>

Transcribe findings into `### Review Findings`.

If changes requested: create new TDD work items under Phase 4 for each fix (Red → Green → Refactor), run them, then re-dispatch reviewers. Record fixes in `### Fixes Applied`.

<gate id="review-approval" requires="user_approval">
Update plan file: `status: awaiting-review-confirm`.
<action>Ask: "Review approved. Ready to finish?"</action>
<action>DO NOT PROCEED until user confirms.</action>
<action>On confirmation: set `status: finishing`, append History Log.</action>
</gate>

## Phase 6: Finish

Update plan file: Phase 6 status → `[~]`.

<dispatch agent="validator">Final validation: run tests fresh, check no uncommitted changes, verify every work item in the plan file is `[x]`. Report status. {{PLAN_FILE_UPDATE_CONTRACT}}</dispatch>

<options>
<option id="1">Merge locally — merge to base branch, delete feature branch</option>
<option id="2">Create PR — push and create pull request</option>
<option id="3">Keep as-is — leave branch intact</option>
<option id="4">Discard — delete branch and all changes (requires user to type "discard")</option>
</options>

Execute the user's choice. Mark Phase 6 `[x]`, `status: done`, `current_item: null`, append final History Log line.

<question_relay>
When a delegated agent returns with a question instead of a deliverable:
<step>Detect: The agent response contains a question or "need clarification" — not a completed deliverable.</step>
<step>Relay: Present the agent's question to the user exactly as stated. Add context: which phase, which work item, which agent.</step>
<step>Wait: Do not proceed, guess, or answer on the user's behalf.</step>
<step>Resume: Use the Task tool's resume parameter with the agent's ID to continue with the user's answer.</step>
<step>Repeat: If the resumed agent asks again, relay again.</step>
<never>Answer an agent's question yourself, skip the question, or re-spawn a new agent losing context.</never>
</question_relay>

<red_flags>
<flag>You wrote production code or tests yourself instead of dispatching agents</flag>
<flag>You ran the test suite yourself instead of dispatching validator</flag>
<flag>You proceeded past a GATE without user confirmation</flag>
<flag>You skipped agent discovery</flag>
<flag>You dispatched parallel agents one at a time instead of all in a single message</flag>
<flag>You wrote production code before a failing test existed (TDD violation)</flag>
<flag>You skipped the Refactor phase on any work item</flag>
<flag>You forgot to include the Plan-File Update Contract in a dispatch</flag>
<flag>You edited source files via Read/Write/Edit — those tools are ONLY for the plan file</flag>
<flag>You didn't update the plan file's `status`, `updated_at`, `current_phase`, or History Log at a phase transition</flag>
<flag>You ran a non-git, non-date Bash command (build, test, install, compile, tidy) instead of delegating</flag>
<flag>You fixed code or errors yourself after an agent returned, instead of dispatching another agent</flag>
</red_flags>
