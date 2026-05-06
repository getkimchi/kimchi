---
name: explore-and-plan
description: Use when starting a new task, need to understand codebase structure, or must create an implementation plan before coding.
when_to_use: Starting a new feature or fix and the codebase area is unfamiliar. Phrases like "plan X", "explore the codebase", "understand how Y works before I change it".
allowed-tools: [Task]
argument-hint: [task description]
model: minimax-m2.7
effort: medium
---

# Explore and Plan

**Core principle:** Never code blind. Understand first, plan second, implement third.

<orchestrator_role>
<rule>YOU DO NOT READ SOURCE FILES YOURSELF.</rule>
<rule>YOU DO NOT EXPLORE THE CODEBASE YOURSELF.</rule>
<rule>YOU DELEGATE all exploration and planning to agents via the Task tool.</rule>
<rule>You COORDINATE, SYNTHESIZE, and PRESENT — nothing else.</rule>
<rule>PARALLEL MEANS PARALLEL: When a &lt;dispatch_strategy name="parallel"&gt; block appears, you MUST dispatch ALL agents inside it using multiple Task tool calls in a SINGLE message. If you dispatch them one at a time waiting for each to complete, you have failed the workflow.</rule>
<rule>Before dispatching agents, copy the matching prompt template from &lt;prompt_templates&gt; (they are inlined below in this document). Fill in {{PLACEHOLDERS}} with actual values from the task context. Send the filled template as the agent's prompt — do NOT invent prompts from scratch.</rule>
<rule>If you use Bash, it is ONLY for git commands (git diff, git log, git status). NEVER run build, test, install, compile, or tidy commands — delegate those to agents.</rule>
<rule>When an agent returns with errors, build failures, or warnings — dispatch another agent (expert-coder or debugger) to fix them. NEVER fix issues yourself, no matter how trivial they seem.</rule>
</orchestrator_role>

<triggers>
<trigger>Starting any new feature or fix</trigger>
<trigger>Unfamiliar with the codebase area</trigger>
<trigger>Task requirements are unclear</trigger>
<trigger>Need to identify affected files/components</trigger>
</triggers>

<agent_discovery required="true">
Before doing ANYTHING else, check the Task tool's subagent_type options to see ALL available agents. Print the full list so the user can see what's available.
These are the default agents for this workflow — use alternatives if any aren't available:
<agent role="exploration">Explore</agent>
<agent role="planning">Plan</agent>
<agent role="architecture">orchestrator-workflows:architecture-analyzer</agent>
<agent role="file-mapping">orchestrator-workflows:file-mapper</agent>
Map each role to the best matching available agent. Do NOT proceed until discovery is complete.
</agent_discovery>

<prompt_templates>
The agent prompt templates are inlined below in this document. For each agent dispatch, copy the matching template, fill in all {{PLACEHOLDERS}} with actual values from context, and send it as the agent's prompt — do NOT invent prompts from scratch.
<template agent="Explore">
# Explorer Agent Template

Use this template when delegating to an exploration/analysis agent.

---

## Task: Explore {{TOPIC_OR_AREA}}

**Question to answer:**
{{SPECIFIC_QUESTION}}

**Context:**
{{WHY_WE_NEED_TO_KNOW}}

**Suspected locations:**
{{HINTS_IF_ANY}}

---

## Your Workflow

1. **Search broadly first** - Use Glob/Grep to find relevant files
2. **Read discovered files** - Understand structure and patterns
3. **Map relationships** - How do components connect?
4. **Answer the question** - Provide specific, actionable findings

---

## Report Format

```markdown
## Exploration: {{TOPIC_OR_AREA}}

### Answer
[Direct answer to the question asked]

### Relevant Files
| File | Purpose | Relevance |
|------|---------|-----------|
| [path] | [what it does] | [why it matters] |

### Patterns Discovered
- [Pattern 1]: [where used, how it works]
- [Pattern 2]: [where used, how it works]

### Architecture Notes
[How this area fits into the larger system]

### Recommendations
[If applicable, suggestions based on findings]

### Files to Read for More Context
- [file]: [why]
```

---

## Exploration Principles

### Be Thorough
- Don't stop at first result
- Look for multiple implementations
- Check for edge cases and exceptions

### Be Specific
- Provide exact file paths
- Include line numbers for key findings
- Quote relevant code snippets

### Be Objective
- Report what IS, not what should be
- Note both good patterns and problems
- Don't assume, verify
</template>
</prompt_templates>

## Phase 1: Exploration

**Dispatch exploration agents via the Task tool. Do NOT explore yourself.**

<dispatch_strategy name="parallel" instruction="Send ALL dispatches below as multiple Task tool calls in ONE single message" condition="large or unfamiliar codebase, task touches 2+ modules, or scope is broad">
<dispatch agent="Explore">Map directory structure, tech stack, entry points, and build system for this project.</dispatch>
<dispatch agent="Explore">Find all files related to [user's task]. Map dependencies and data flow in that area.</dispatch>
<dispatch agent="Explore">Find similar implementations and patterns in the codebase that we should reference.</dispatch>
</dispatch_strategy>

<dispatch_strategy name="sequential" condition="small codebase or task clearly localized to one file/directory">
<dispatch agent="Explore">Explore the codebase to understand [user's task]. Find relevant files, patterns, dependencies, and similar implementations.</dispatch>
</dispatch_strategy>

After agents return, **synthesize their findings** into a single exploration summary.

## Phase 2: Planning

<dispatch agent="Plan">Based on these exploration findings: [paste synthesized summary]. Create an implementation plan for: [user's task]. Include: files to create/modify, step-by-step approach, tests to write, risks, and acceptance criteria.</dispatch>

## Phase 3: Architecture Validation

<dispatch agent="architecture-analyzer">Review this implementation plan against the codebase architecture: [paste plan]. Check: does it follow existing patterns? Any unnecessary complexity? Potential issues? Concerns?</dispatch>

<gate requires="user_approval">
STOP HERE.
<present>Exploration summary (key files, patterns, constraints)</present>
<present>The implementation plan</present>
<present>Architecture feedback</present>
<action>Ask: "Do you approve this plan? Any changes?"</action>
<action>DO NOT proceed to implementation until user approves.</action>
</gate>

<transition>
<step>Mark exploration todos as complete</step>
<step>Tell the user to invoke orchestrator-workflows:development-workflow with the approved plan</step>
<step>Or if running within full-cycle, proceed to Phase 4</step>
</transition>

<todo>
<task>Step 0: Discover available agents</task>
<task>Phase 1: Explore — dispatch via Task tool</task>
<task>Exploration agents dispatched (parallel if warranted)</task>
<task>Synthesize findings into summary</task>
<task>Phase 2: Plan — dispatch planning agent via Task tool</task>
<task>Phase 3: Validate — dispatch architecture agent via Task tool</task>
<task>GATE: Present plan to user → WAIT for approval</task>
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
<flag>You are using Glob, Grep, or Read to explore source code instead of dispatching an Explore agent</flag>
<flag>You are writing the plan yourself instead of dispatching a Plan agent</flag>
<flag>You proceeded past the GATE without user approval</flag>
<flag>You skipped agent discovery</flag>
<flag>You dispatched parallel agents one at a time instead of all in a single message</flag>
<flag>You ran a non-git Bash command (build, test, install, compile, tidy) instead of delegating to an agent</flag>
<flag>You fixed code or errors yourself after an agent returned, instead of dispatching another agent</flag>
</red_flags>
