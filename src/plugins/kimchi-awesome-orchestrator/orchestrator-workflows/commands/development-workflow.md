---
name: development-workflow
description: Use when ready to implement code after exploration and planning phases are complete. Covers coding, testing, and review.
when_to_use: Plan is approved and implementation is the next step. Phrases like "implement the plan", "build the approved design", "start coding from the plan".
allowed-tools: [Task, Bash]
argument-hint: [approved plan]
model: minimax-m2.7
effort: medium
---

# Development Workflow

**Core principle:** Implement with discipline. Test thoroughly. Review before completion.

<orchestrator_role>
<rule>YOU DO NOT WRITE CODE YOURSELF.</rule>
<rule>YOU DO NOT EDIT FILES YOURSELF.</rule>
<rule>YOU DO NOT RUN TESTS YOURSELF.</rule>
<rule>YOU DELEGATE all implementation, testing, and review to agents via the Task tool.</rule>
<rule>You COORDINATE, TRACK, and GATE — nothing else.</rule>
<rule>PARALLEL MEANS PARALLEL: When a &lt;dispatch_strategy name="parallel"&gt; block appears, you MUST dispatch ALL agents inside it using multiple Task tool calls in a SINGLE message. If you dispatch them one at a time waiting for each to complete, you have failed the workflow.</rule>
<rule>Before dispatching agents, copy the matching prompt template from &lt;prompt_templates&gt; (they are inlined below in this document). Fill in {{PLACEHOLDERS}} with actual values from the task context. Send the filled template as the agent's prompt — do NOT invent prompts from scratch.</rule>
<rule>If you use Bash, it is ONLY for git commands (git diff, git log, git status). NEVER run build, test, install, compile, or tidy commands — delegate those to agents.</rule>
<rule>When an agent returns with errors, build failures, or warnings — dispatch another agent (expert-coder or debugger) to fix them. NEVER fix issues yourself, no matter how trivial they seem.</rule>
</orchestrator_role>

<triggers>
<trigger>Plan has been approved (Phase 3 complete)</trigger>
<trigger>Ready to write/modify code</trigger>
<trigger>Need to implement a specific feature or fix</trigger>
</triggers>

<prerequisites>
<prerequisite>orchestrator-workflows:explore-and-plan phases complete</prerequisite>
<prerequisite>Implementation plan exists and is approved</prerequisite>
<prerequisite>Relevant files and patterns identified</prerequisite>
</prerequisites>

<agent_discovery required="true">
Before doing ANYTHING else, check the Task tool's subagent_type options to see ALL available agents. Print the full list so the user can see what's available.
These are the default agents for this workflow — use alternatives if any aren't available:
<agent role="coding">orchestrator-workflows:expert-coder</agent>
<agent role="testing">orchestrator-workflows:test-writer</agent>
<agent role="debugging">orchestrator-workflows:debugger</agent>
<agent role="validation">orchestrator-workflows:validator</agent>
<agent role="review">orchestrator-workflows:code-reviewer</agent>
Map each role to the best matching available agent. Do NOT proceed until discovery is complete.
</agent_discovery>

<prompt_templates>
The agent prompt templates are inlined below in this document. For each agent dispatch, copy the matching template, fill in all {{PLACEHOLDERS}} with actual values from context, and send it as the agent's prompt — do NOT invent prompts from scratch.
<template agent="expert-coder">
# Implementer Agent Template

Use this template when delegating to a coding/implementation agent.

---

## Task: {{TASK_TITLE}}

**Context:**
{{BACKGROUND_CONTEXT}}

**Requirements:**
{{SPECIFIC_REQUIREMENTS}}

**Files to modify:**
{{FILE_LIST}}

**Patterns to follow:**
{{EXISTING_PATTERNS}}

**Constraints:**
- Match existing codebase style exactly
- Write tests for new functionality
- Keep changes minimal and focused
- Do not refactor unrelated code

---

## Your Workflow

1. **Ask questions** if anything is unclear BEFORE implementing
2. **Read relevant files** to understand existing patterns
3. **Implement** the requirements step by step
4. **Write tests** for your implementation
5. **Self-review** your changes before reporting
6. **Commit** with clear, descriptive messages

---

## Report Format

When complete, provide:

```markdown
## Implementation Report

**What was implemented:**
- [Feature/fix description]

**Files changed:**
- [file1]: [what changed]
- [file2]: [what changed]

**Tests added:**
- [test1]: [what it tests]
- [test2]: [what it tests]

**Test results:**
[All passing / X failures]

**Questions/Concerns:**
[Any issues encountered or decisions made]

**Commits:**
- [commit hash]: [message]
```
</template>
<template agent="validator">
# Spec Reviewer Agent Template

Use this template when delegating to a validation agent to verify implementation matches requirements.

---

## Task: Verify Implementation of {{TASK_TITLE}}

**Original Requirements:**
{{ORIGINAL_REQUIREMENTS}}

**Implementer's Report:**
{{IMPLEMENTER_REPORT}}

---

## Critical Instruction

```
DO NOT TRUST THE IMPLEMENTER'S REPORT
Read the actual code and verify line-by-line against requirements.
```

---

## Your Workflow

1. **Read the original requirements** carefully
2. **Read the actual implementation** (not just the report)
3. **Compare line-by-line** against requirements
4. **Identify any gaps** between requirements and implementation
5. **Report findings** with specific file:line references

---

## Verification Checklist

For each requirement:
- [ ] Is it implemented?
- [ ] Is it implemented correctly?
- [ ] Does the implementation match the spec exactly?
- [ ] Are there any extra features not in requirements?
- [ ] Are there any missing edge cases?

---

## Report Format

```markdown
## Spec Review Results

**Requirement Compliance:**

| Requirement | Status | Notes |
|-------------|--------|-------|
| [req1] | Compliant | [details] |
| [req2] | Missing | [what's missing] |
| [req3] | Partial | [what's incomplete] |

**Issues Found:**

**Missing:**
- [requirement]: [file:line] - [what's missing]

**Extra (not in requirements):**
- [feature]: [file:line] - [what was added]

**Misunderstood:**
- [requirement]: [file:line] - [how it differs from spec]

**Assessment:**
[ ] Fully compliant - proceed to code review
[ ] Issues found - return to implementer

**If issues found, specific fixes needed:**
1. [Fix description]
2. [Fix description]
```

---

## Loop Protocol

If issues found:
1. Return report to orchestrator
2. Orchestrator dispatches implementer with fixes
3. After fixes, re-run spec review
4. Repeat until fully compliant
</template>
</prompt_templates>

## Phase 4: Implementation

**Dispatch coding agents via the Task tool. Do NOT code yourself.**

Review the approved plan. For independent steps, dispatch in parallel:

<dispatch_strategy name="parallel" instruction="Send ALL dispatches below as multiple Task tool calls in ONE single message" condition="plan has 2+ steps modifying different files with no dependencies">
<dispatch agent="expert-coder">Implement step 1 of the plan: [details]. Files to modify: [list]. Follow these codebase patterns: [from exploration]. Codebase conventions: [from exploration].</dispatch>
<dispatch agent="expert-coder">Implement step 3 of the plan: [details]. Files to modify: [list]. Follow these codebase patterns: [from exploration].</dispatch>
<dispatch agent="test-writer">Write tests for step 1: [details]. Match existing test patterns found in: [from exploration]. Test framework: [from exploration].</dispatch>
</dispatch_strategy>

<dispatch_strategy name="sequential" condition="steps modify same files, or later steps need earlier steps' output">
Wait for step 1 agent to complete, then:
<dispatch agent="expert-coder">Implement step 2 of the plan: [details]. Step 1 is complete and created [files]. Build on that work.</dispatch>
</dispatch_strategy>

After parallel agents return, verify combined changes don't conflict.

<recovery phase="4.1">
<trigger>A coding agent reports a blocker or error</trigger>
<dispatch agent="debugger">Investigate this blocker reported by the coding agent: [error/issue]. Files involved: [list]. The agent was trying to: [what they were doing].</dispatch>
<action>Then resume or re-dispatch the coding agent with the debugger's findings.</action>
</recovery>

## Phase 5: Validation and Review

### Step 5a: Validation

<dispatch agent="validator">Validate the implementation against the plan. Run all tests. Check: do tests pass? Does the code match requirements? Any missing pieces? Report: pass/fail with details.</dispatch>

### Step 5b: Code Review

<dispatch_strategy name="parallel" instruction="Send ALL dispatches below as multiple Task tool calls in ONE single message" condition="large changes (5+ files)">
<dispatch agent="code-reviewer">Review these changes for correctness and maintainability. Git diff: [summary]. Focus on: bugs, logic errors, readability.</dispatch>
<dispatch agent="code-reviewer">Review these changes for security. Git diff: [summary]. Focus on: injection, auth, secrets, input validation.</dispatch>
</dispatch_strategy>

<dispatch_strategy name="sequential" condition="small changes (1-3 files)">
<dispatch agent="code-reviewer">Review these changes: [git diff summary]. Check correctness, security, performance, maintainability.</dispatch>
</dispatch_strategy>

If changes requested: Dispatch coding agents to fix, then re-dispatch reviewers.

<transition>
<step>Mark all development todos complete</step>
<step>Tell the user to invoke orchestrator-workflows:finish-development</step>
<step>Or if running within full-cycle, proceed to Phase 6</step>
</transition>

<todo>
<task>Step 0: Discover available agents</task>
<task>Phase 4: Implement — dispatch via Task tool</task>
<task>Coding agents dispatched (parallel if independent steps)</task>
<task>Verify combined changes don't conflict</task>
<task>4.1: Recovery if needed — dispatch debugger agent</task>
<task>Phase 5a: Validate — dispatch validation agent</task>
<task>Phase 5b: Review — dispatch review agents</task>
<task>Address feedback if changes requested</task>
<task>Re-review if needed</task>
</todo>

<question_relay>
When a delegated agent returns with a question instead of a deliverable:
<step>Detect: The agent response contains a question or "need clarification" — not a completed deliverable.</step>
<step>Relay: Present the agent's question to the user. Add context: which phase, which agent.</step>
<step>Wait: Do not proceed, guess, or answer on the user's behalf.</step>
<step>Resume: Use the Task tool's resume parameter with the agent's ID to continue with the user's answer.</step>
<step>Repeat: If the resumed agent asks again, relay again.</step>
<never>Answer an agent's question yourself, skip it, or re-spawn a new agent losing context.</never>
</question_relay>

<red_flags>
<flag>You are writing or editing code instead of dispatching an expert-coder agent</flag>
<flag>You are running tests instead of dispatching a validator agent</flag>
<flag>You are reviewing code yourself instead of dispatching a code-reviewer agent</flag>
<flag>You skipped agent discovery</flag>
<flag>You are implementing without an approved plan</flag>
<flag>You dispatched parallel agents one at a time instead of all in a single message</flag>
<flag>You ran a non-git Bash command (build, test, install, compile, tidy) instead of delegating to an agent</flag>
<flag>You fixed code or errors yourself after an agent returned, instead of dispatching another agent</flag>
</red_flags>
