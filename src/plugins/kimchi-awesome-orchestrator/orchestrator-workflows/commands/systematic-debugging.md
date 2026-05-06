---
name: systematic-debugging
description: Use when something is broken, tests are failing, errors are occurring, or behavior is unexpected. Never guess at fixes.
when_to_use: A non-trivial bug where root cause matters. Phrases like "debug X", "why is Y failing", "tests broken", "unexpected behavior".
allowed-tools: [Task]
argument-hint: [error or symptom description]
model: minimax-m2.7
effort: high
---

# Systematic Debugging

**Core principle:** Understand before fixing. Root cause first, solution second.

<orchestrator_role>
<rule>YOU DO NOT DEBUG CODE YOURSELF.</rule>
<rule>YOU DO NOT READ SOURCE FILES TO INVESTIGATE YOURSELF.</rule>
<rule>YOU DO NOT APPLY FIXES YOURSELF.</rule>
<rule>YOU DELEGATE all investigation, diagnosis, and fixing to agents via the Task tool.</rule>
<rule>You COORDINATE, HYPOTHESIZE (Phase 2 only), and SYNTHESIZE — nothing else.</rule>
<rule>PARALLEL MEANS PARALLEL: When a &lt;dispatch_strategy name="parallel"&gt; block appears, you MUST dispatch ALL agents inside it using multiple Task tool calls in a SINGLE message. If you dispatch them one at a time waiting for each to complete, you have failed the workflow.</rule>
<rule>Before dispatching agents, copy the matching prompt template from &lt;prompt_templates&gt; (they are inlined below in this document). Fill in {{PLACEHOLDERS}} with actual values from the task context. Send the filled template as the agent's prompt — do NOT invent prompts from scratch.</rule>
<rule>If you use Bash, it is ONLY for git commands (git diff, git log, git status). NEVER run build, test, install, compile, or tidy commands — delegate those to agents.</rule>
<rule>When an agent returns with errors, build failures, or warnings — dispatch another agent (expert-coder or debugger) to fix them. NEVER fix issues yourself, no matter how trivial they seem.</rule>
</orchestrator_role>

<triggers>
<trigger>Tests are failing</trigger>
<trigger>Errors in logs or output</trigger>
<trigger>Unexpected behavior</trigger>
<trigger>Something that "should work" doesn't</trigger>
<trigger>Regression after changes</trigger>
</triggers>

<iron_law>
<rule>NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST</rule>
<rule>If Phase 1 is not complete, you cannot dispatch a fix.</rule>
</iron_law>

<agent_discovery required="true">
Before doing ANYTHING else, check the Task tool's subagent_type options to see ALL available agents. Print the full list so the user can see what's available.
These are the default agents for this workflow — use alternatives if any aren't available:
<agent role="debugging">orchestrator-workflows:debugger</agent>
<agent role="exploration">Explore</agent>
<agent role="coding">orchestrator-workflows:expert-coder</agent>
<agent role="testing">orchestrator-workflows:test-writer</agent>
<agent role="validation">orchestrator-workflows:validator</agent>
Map each role to the best matching available agent. Do NOT proceed until discovery is complete.
</agent_discovery>

<prompt_templates>
The agent prompt templates are inlined below in this document. For each agent dispatch, copy the matching template, fill in all {{PLACEHOLDERS}} with actual values from context, and send it as the agent's prompt — do NOT invent prompts from scratch.
<template agent="debugger">
# Debugger Agent Template

Use this template when delegating to a debugging/investigation agent.

---

## Task: Investigate {{ISSUE_DESCRIPTION}}

**Symptoms:**
{{OBSERVED_BEHAVIOR}}

**Expected behavior:**
{{EXPECTED_BEHAVIOR}}

**Reproduction steps:**
{{REPRO_STEPS}}

**Error messages/logs:**
```
{{ERROR_OUTPUT}}
```

**Suspected area:**
{{FILE_OR_MODULE_HINTS}}

---

## Your Workflow

### Phase 1: Reproduce
1. Follow reproduction steps exactly
2. Confirm the failure occurs
3. Note the exact error output
4. Identify what IS working (boundaries)

### Phase 2: Investigate
1. Read relevant code
2. Trace execution path
3. Identify root cause (not symptoms)
4. Gather evidence

### Phase 3: Propose Fix
1. Describe root cause with evidence
2. Propose minimal fix
3. Identify risks of the fix
4. DO NOT IMPLEMENT unless instructed

---

## Report Format

```markdown
## Debug Investigation: {{ISSUE_DESCRIPTION}}

### Reproduction
- [ ] Reproduced: [Yes/No]
- Exact error: [error message]
- Failure point: [file:line]

### Root Cause Analysis

**What's happening:**
[Describe the failure mechanism]

**Why it's happening:**
[Describe the root cause]

**Evidence:**
- [file:line]: [what this shows]
- [log/trace]: [what this confirms]

### Proposed Fix

**Location:** [file:line]

**Change:**
```diff
- [old code]
+ [new code]
```

**Why this fixes it:**
[Explanation]

**Risks:**
- [Potential side effects]
- [What to watch for]

### Verification Plan
1. [How to verify fix works]
2. [How to verify no regressions]

### Questions/Blockers
[Any issues that prevent completion]
```

---

## Investigation Principles

### Root Cause Tracing
Work backwards from the failure:
1. What was the immediate cause?
2. What caused that?
3. Keep asking until you reach the true root

### Don't Fix Symptoms
- **Symptom:** User sees error message
- **Root cause:** Email parsing strips special characters
- **Bad fix:** Catch error and show different message
- **Good fix:** Fix email parsing to handle special characters

### Minimal Fix
- Fix only what's broken
- Don't refactor surrounding code
- Don't add "improvements" while you're in there
</template>
</prompt_templates>

## Phase 1: Reproduce and Observe

**Dispatch debugging agents via the Task tool. Do NOT investigate yourself.**

<dispatch_strategy name="sequential" condition="single-component issue or error points to exact location">
<dispatch agent="debugger">Investigate this issue: [error/symptom]. Reproduce the failure. Capture the full error context. Identify the exact point of failure. Report: reproduction steps, error details, what IS working.</dispatch>
</dispatch_strategy>

<dispatch_strategy name="parallel" instruction="Send ALL dispatches below as multiple Task tool calls in ONE single message" condition="multi-component system, unclear which layer is failing">
<dispatch agent="debugger">Check layer A [name]: inputs, outputs, state, logs. Is data correct entering and leaving this layer? Report findings.</dispatch>
<dispatch agent="debugger">Check layer B [name]: inputs, outputs, state, logs. Is data correct entering and leaving this layer? Report findings.</dispatch>
<dispatch agent="debugger">Check layer C [name]: inputs, outputs, state, logs. Is data correct entering and leaving this layer? Report findings.</dispatch>
</dispatch_strategy>

After agents return, synthesize findings to identify which boundary the data goes wrong.

## Phase 2: Hypothesize

<orchestrator_self_work>
This is the ONE phase you do yourself (as orchestrator):
<step>Form 2-3 hypotheses about root cause based on Phase 1 findings</step>
<step>Rank by likelihood</step>
<step>Identify what evidence would confirm/refute each</step>
Present hypotheses to proceed.
</orchestrator_self_work>

## Phase 3: Investigate and Verify

<dispatch agent="debugger">Test this hypothesis: [hypothesis]. Gather evidence: [what to check]. Look at: [specific files/logs/state]. Report: confirmed or eliminated, with evidence.</dispatch>

If first hypothesis is eliminated:

<dispatch agent="debugger" action="resume">Hypothesis 1 was eliminated. Test hypothesis 2: [hypothesis]. Gather evidence: [what to check].</dispatch>

## Phase 4: Fix and Verify

<dispatch agent="test-writer">Write a failing test that captures this bug: [confirmed root cause]. The test should fail now and pass after the fix.</dispatch>

Then:

<dispatch agent="expert-coder">Fix this bug. Root cause: [confirmed cause]. Evidence: [from Phase 3]. Apply minimal fix to: [specific files]. The failing test is: [test location].</dispatch>

Then:

<dispatch agent="validator">Verify the bug fix. Run all tests. Check: does the new test pass? Are there any regressions? Report results.</dispatch>

## Multi-Failure Debugging

<dispatch_strategy name="parallel" instruction="Send ALL dispatches below as multiple Task tool calls in ONE single message" condition="multiple independent issues exist">
<dispatch agent="debugger">Investigate failure 1: [details]. Scope: [files/module].</dispatch>
<dispatch agent="debugger">Investigate failure 2: [details]. Scope: [files/module].</dispatch>
<dispatch agent="debugger">Investigate failure 3: [details]. Scope: [files/module].</dispatch>
</dispatch_strategy>

Each failure gets independent investigation. Do not assume they are related.

<todo>
<task>Step 0: Discover available agents</task>
<task>Phase 1: Reproduce — dispatch debugger agents via Task tool</task>
<task>Agents dispatched (parallel if multi-component)</task>
<task>Synthesize: identify failing boundary</task>
<task>Phase 2: Hypothesize — orchestrator forms ranked hypotheses</task>
<task>Phase 3: Investigate — dispatch debugger agent to test hypotheses</task>
<task>Phase 4: Fix — dispatch test-writer for failing test</task>
<task>Dispatch expert-coder for minimal fix</task>
<task>Dispatch validator to verify fix + no regressions</task>
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
<flag>You are reading source files to debug instead of dispatching a debugger agent</flag>
<flag>You are applying fixes instead of dispatching an expert-coder agent</flag>
<flag>You proposed a fix without completing Phase 1 investigation</flag>
<flag>You skipped the failing test before fixing</flag>
<flag>You skipped agent discovery</flag>
<flag>You dispatched parallel agents one at a time instead of all in a single message</flag>
<flag>You ran a non-git Bash command (build, test, install, compile, tidy) instead of delegating to an agent</flag>
<flag>You fixed code or errors yourself after an agent returned, instead of dispatching another agent</flag>
</red_flags>
