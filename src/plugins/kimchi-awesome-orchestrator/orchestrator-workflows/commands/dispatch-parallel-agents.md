---
name: dispatch-parallel-agents
description: Use when multiple independent investigations, implementations, or reviews can run concurrently without blocking each other.
when_to_use: User has multiple independent tasks to run in parallel — "investigate these 3 bugs", "review these modules separately", "explore approach A and B".
allowed-tools: [Task]
argument-hint: [list of independent tasks]
model: minimax-m2.7
effort: medium
---

# Dispatch Parallel Agents

**Core principle:** Independent work should happen in parallel. Dependent work must be sequential.

<orchestrator_role>
<rule>YOU DO NOT DO THE PARALLEL WORK YOURSELF.</rule>
<rule>YOU DELEGATE all parallel tasks to agents via the Task tool.</rule>
<rule>You VERIFY independence, DISPATCH agents, and SYNTHESIZE results — nothing else.</rule>
<rule>PARALLEL MEANS PARALLEL: You MUST dispatch ALL agents using multiple Task tool calls in a SINGLE message. If you dispatch them one at a time waiting for each to complete, you have failed the workflow.</rule>
</orchestrator_role>

<triggers>
<trigger>Multiple files need independent investigation</trigger>
<trigger>Several unrelated bugs to diagnose</trigger>
<trigger>Parallel implementations that don't conflict</trigger>
<trigger>Multiple code reviews needed</trigger>
<trigger>Exploration of different approaches</trigger>
</triggers>

<do_not_use>
<condition>Tasks depend on each other's output</condition>
<condition>Same files would be modified</condition>
<condition>Shared state could cause conflicts</condition>
</do_not_use>

<agent_discovery required="true">
Check Task tool's subagent_type options for available agents.
Choose appropriate agent types for your parallel tasks.
</agent_discovery>

## Step 1: Independence Check

<independence_check>
<verify>Tasks don't share modified files</verify>
<verify>Tasks don't depend on each other's results</verify>
<verify>Tasks can be merged without conflicts</verify>
<verify>Each task has clear, isolated scope</verify>
</independence_check>

## Step 2: Dispatch Agents in Parallel

**Use the Task tool to dispatch ALL independent agents in a single message.**

<dispatch_strategy name="parallel" instruction="Send ALL dispatches below as multiple Task tool calls in ONE single message" example="Parallel Investigation">
<dispatch agent="debugger">Investigate failure in module A: [details]. Scope: [files]. Report: root cause, evidence, recommended fix (do not implement).</dispatch>
<dispatch agent="debugger">Investigate failure in module B: [details]. Scope: [files]. Report: root cause, evidence, recommended fix (do not implement).</dispatch>
<dispatch agent="debugger">Investigate failure in module C: [details]. Scope: [files]. Report: root cause, evidence, recommended fix (do not implement).</dispatch>
</dispatch_strategy>

<dispatch_strategy name="parallel" instruction="Send ALL dispatches below as multiple Task tool calls in ONE single message" example="Parallel Implementation">
<dispatch agent="expert-coder">Implement feature X. Files: [a.ts, b.ts]. Requirements: [details]. Patterns to follow: [details].</dispatch>
<dispatch agent="expert-coder">Implement feature Y. Files: [c.ts, d.ts]. Requirements: [details]. Patterns to follow: [details].</dispatch>
</dispatch_strategy>

<dispatch_strategy name="parallel" instruction="Send ALL dispatches below as multiple Task tool calls in ONE single message" example="Parallel Review">
<dispatch agent="code-reviewer">Security review of changes: [diff summary]. Focus on injection, auth, secrets.</dispatch>
<dispatch agent="code-reviewer">Performance review of changes: [diff summary]. Focus on N+1 queries, allocations, resource leaks.</dispatch>
<dispatch agent="code-reviewer">Correctness review of changes: [diff summary]. Focus on bugs, edge cases, logic errors.</dispatch>
</dispatch_strategy>

<dispatch_strategy name="parallel" instruction="Send ALL dispatches below as multiple Task tool calls in ONE single message" example="Parallel Exploration">
<dispatch agent="Explore">Explore approach A viability: [details]. Report: pros, cons, effort estimate.</dispatch>
<dispatch agent="Explore">Explore approach B viability: [details]. Report: pros, cons, effort estimate.</dispatch>
</dispatch_strategy>

## Step 3: Synthesize Results

After ALL agents return:

<synthesis>
<step>Collect all outputs</step>
<step>Check for conflicts (same file modified, contradicting recommendations)</step>
<step>Resolve conflicts: prefer evidence-backed conclusions, ask user if agents contradict, sequential re-run if truly conflicting</step>
<step>Present unified results to user or next phase</step>
</synthesis>

<todo>
<task>Step 0: Discover available agents</task>
<task>Step 1: Independence check passed</task>
<task>Step 2: Parallel dispatch — Agent 1: [task description]</task>
<task>Step 2: Parallel dispatch — Agent 2: [task description]</task>
<task>Step 2: Parallel dispatch — Agent 3: [task description]</task>
<task>Step 3: Synthesize results</task>
</todo>

<question_relay>
When a delegated agent returns with a question instead of a deliverable:
<step>Detect: The agent response contains a question or "need clarification" — not a completed deliverable.</step>
<step>Relay: Present the agent's question to the user. Add context: which parallel task, which agent.</step>
<step>Wait: Do not proceed with that agent's task. Other agents that returned deliverables CAN continue being processed.</step>
<step>Resume: Use the Task tool's resume parameter with the agent's ID to continue with the user's answer.</step>
<step>Repeat: If the resumed agent asks again, relay again.</step>
<never>Answer an agent's question yourself, skip it, or re-spawn a new agent losing context.</never>
</question_relay>

<red_flags>
<flag>You are doing the parallel work yourself instead of dispatching agents</flag>
<flag>Tasks share modified files (not independent)</flag>
<flag>One task needs another's output (not independent)</flag>
<flag>You dispatched only one agent (no parallelism needed)</flag>
<flag>You skipped the independence check</flag>
<flag>You skipped agent discovery</flag>
<flag>You dispatched agents one at a time instead of all in a single message</flag>
</red_flags>
