---
name: request-code-review
description: Use when implementation is complete and you need quality review before finishing. Delegates to code reviewer agent with proper context.
when_to_use: Changes are implemented and should be reviewed before merging. Phrases like "review my changes", "code review please", "check this before I merge".
allowed-tools: [Task, Bash]
argument-hint: [optional scope or diff range]
model: minimax-m2.7
effort: medium
---

# Request Code Review

**Core principle:** Fresh eyes catch what tired eyes miss. Always review before shipping.

<orchestrator_role>
<rule>YOU DO NOT REVIEW CODE YOURSELF.</rule>
<rule>YOU DELEGATE all review work to agents via the Task tool.</rule>
<rule>You PREPARE the review context, DISPATCH reviewers, and RELAY findings — nothing else.</rule>
<rule>PARALLEL MEANS PARALLEL: When a &lt;dispatch_strategy name="parallel"&gt; block appears, you MUST dispatch ALL agents inside it using multiple Task tool calls in a SINGLE message. If you dispatch them one at a time waiting for each to complete, you have failed the workflow.</rule>
<rule>Before dispatching agents, copy the matching prompt template from &lt;prompt_templates&gt; (they are inlined below in this document). Fill in {{PLACEHOLDERS}} with actual values from the task context. Send the filled template as the agent's prompt — do NOT invent prompts from scratch.</rule>
<rule>If you use Bash, it is ONLY for git commands (git diff, git log, git status). NEVER run build, test, install, compile, or tidy commands — delegate those to agents.</rule>
<rule>When an agent returns with errors, build failures, or warnings — dispatch another agent (expert-coder or debugger) to fix them. NEVER fix issues yourself, no matter how trivial they seem.</rule>
</orchestrator_role>

<triggers>
<trigger>Implementation complete</trigger>
<trigger>Before merging to main branch</trigger>
<trigger>Want security/performance check</trigger>
<trigger>Significant changes that need scrutiny</trigger>
</triggers>

<prerequisites>
<prerequisite>All tests passing</prerequisite>
<prerequisite>Code committed with clear messages</prerequisite>
<prerequisite>Know what changed (diff available)</prerequisite>
</prerequisites>

<agent_discovery required="true">
Before doing ANYTHING else, check the Task tool's subagent_type options to see ALL available agents. Print the full list so the user can see what's available.
These are the default agents for this workflow — use alternatives if any aren't available:
<agent role="review">orchestrator-workflows:code-reviewer</agent>
<agent role="coding">orchestrator-workflows:expert-coder</agent>
Map each role to the best matching available agent. Do NOT proceed until discovery is complete.
</agent_discovery>

<prompt_templates>
The agent prompt templates are inlined below in this document. For each agent dispatch, copy the matching template, fill in all {{PLACEHOLDERS}} with actual values from context, and send it as the agent's prompt — do NOT invent prompts from scratch.
<template agent="code-reviewer">
# Code Reviewer Agent Template

Use this template when delegating to a code review agent.

---

## Task: Review {{FEATURE_DESCRIPTION}}

**What was implemented:**
{{IMPLEMENTATION_SUMMARY}}

**Files changed:**
{{FILE_LIST}}

**Diff context:**
- Base: {{BASE_REF}}
- Head: {{HEAD_REF}}

---

## Review Focus Areas

### 1. Correctness
- Does the code do what it's supposed to?
- Are all edge cases handled?
- Are error conditions covered?

### 2. Security
- Input validation present?
- Authentication/authorization correct?
- No sensitive data exposure?
- No injection vulnerabilities?

### 3. Performance
- Efficient algorithms and data structures?
- No unnecessary loops or database queries?
- Appropriate caching?

### 4. Maintainability
- Is the code readable?
- Are names clear and descriptive?
- Is there appropriate documentation?
- Does it follow existing patterns?

### 5. Testing
- Are tests meaningful?
- Is coverage adequate?
- Are edge cases tested?

---

## Report Format

```markdown
## Code Review: {{FEATURE_DESCRIPTION}}

### Strengths
- [What's done well]
- [Good patterns used]
- [Positive observations]

### Issues

**Critical (must fix before merge):**
- [Issue]: [file:line] - [explanation] - [suggested fix]

**Important (should fix):**
- [Issue]: [file:line] - [explanation] - [suggested fix]

**Minor (nice to have):**
- [Issue]: [file:line] - [explanation] - [suggested fix]

### Security Checklist
- [ ] Input validation
- [ ] Authentication correct
- [ ] Authorization correct
- [ ] No sensitive data exposure
- [ ] No injection vulnerabilities

### Assessment

[ ] **Approved** - Good to merge
[ ] **Approved with minor changes** - Can merge after addressing minors
[ ] **Changes requested** - Must address important/critical issues
[ ] **Needs significant rework** - Major architectural concerns

### Summary
[One paragraph summary of the review]
```

---

## Loop Protocol

If changes requested:
1. Return report to orchestrator
2. Orchestrator creates todos for each issue
3. Implementer fixes issues
4. Re-run code review
5. Repeat until Approved
</template>
</prompt_templates>

## Step 1: Prepare Review Context

Before dispatching reviewers, gather the diff summary yourself (this is the ONE thing you do directly — run git diff to get the change context to pass to agents):

<orchestrator_self_work>
<command>git diff [base]..HEAD --stat</command>
<command>git log [base]..HEAD --oneline</command>
</orchestrator_self_work>

## Step 2: Dispatch Review Agents

<dispatch_strategy name="parallel" instruction="Send ALL dispatches below as multiple Task tool calls in ONE single message" condition="large or critical changes (5+ files)">
<dispatch agent="code-reviewer">Review these changes for correctness and maintainability. What was implemented: [description]. Files changed: [list]. Diff summary: [paste]. Focus on: bugs, logic errors, edge cases, readability.</dispatch>
<dispatch agent="code-reviewer">Review these changes for security. What was implemented: [description]. Files changed: [list]. Diff summary: [paste]. Focus on: injection, auth bypass, secrets exposure, input validation, path traversal.</dispatch>
<dispatch agent="code-reviewer">Review these changes for performance. What was implemented: [description]. Files changed: [list]. Diff summary: [paste]. Focus on: N+1 queries, unnecessary allocations, missing indexes, resource leaks.</dispatch>
</dispatch_strategy>

<dispatch_strategy name="sequential" condition="small changes (1-3 files)">
<dispatch agent="code-reviewer">Review these changes. What was implemented: [description]. Files changed: [list]. Diff summary: [paste]. Check: correctness, security, performance, maintainability, test coverage.</dispatch>
</dispatch_strategy>

## Step 3: Present Review Results

After reviewers return, merge findings into a single report and present to user:

<review_report_format>
<section severity="critical">Must fix — [Issue]: [file:line] — [suggested fix]</section>
<section severity="important">Should fix — [Issue]: [file:line] — [suggested fix]</section>
<section severity="minor">Nice to fix — [Issue]: [file:line] — [suggestion]</section>
<verdict>Approved / Approved with minor changes / Changes requested</verdict>
</review_report_format>

If reviewers contradict each other, flag the conflict for the user to decide.

## Step 4: Handle Feedback

<on_approved>
Proceed to orchestrator-workflows:finish-development.
</on_approved>

<on_changes_requested>
<dispatch agent="expert-coder">Fix these review issues: [list of issues with file:line references]. Apply minimal changes.</dispatch>
<action>Then re-dispatch reviewers to verify fixes.</action>
</on_changes_requested>

<todo>
<task>Step 0: Discover available agents</task>
<task>Step 1: Prepare review context (git diff)</task>
<task>Step 2: Dispatch review agents via Task tool</task>
<task>Reviewer(s) dispatched (parallel if large changes)</task>
<task>Step 3: Present merged review results</task>
<task>Step 4: Handle feedback</task>
<task>Dispatch expert-coder for fixes (if needed)</task>
<task>Re-review (if needed)</task>
</todo>

<question_relay>
When a delegated agent returns with a question instead of a deliverable:
<step>Detect: The agent response contains a question or "need clarification" — not a completed deliverable.</step>
<step>Relay: Present the agent's question to the user. Add context: which review focus, which agent.</step>
<step>Wait: Do not proceed, guess, or answer on the user's behalf.</step>
<step>Resume: Use the Task tool's resume parameter with the agent's ID to continue with the user's answer.</step>
<step>Repeat: If the resumed agent asks again, relay again.</step>
<never>Answer an agent's question yourself, skip it, or re-spawn a new agent losing context.</never>
</question_relay>

<red_flags>
<flag>You are reading and reviewing code yourself instead of dispatching a code-reviewer agent</flag>
<flag>You dispatched review with failing tests</flag>
<flag>You skipped agent discovery</flag>
<flag>You are applying fixes yourself instead of dispatching an expert-coder agent</flag>
<flag>You dispatched parallel reviewers one at a time instead of all in a single message</flag>
<flag>You ran a non-git Bash command (build, test, install, compile, tidy) instead of delegating to an agent</flag>
<flag>You fixed code or errors yourself after an agent returned, instead of dispatching another agent</flag>
</red_flags>
