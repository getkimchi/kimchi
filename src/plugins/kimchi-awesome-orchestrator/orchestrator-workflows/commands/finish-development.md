---
name: finish-development
description: Use when implementation and review are complete, ready to merge, create PR, or close out the development work.
when_to_use: Code is done and reviewed. Phrases like "ship it", "ready to merge", "open the PR", "wrap this up".
allowed-tools: [Task, Bash]
argument-hint: [optional PR target or notes]
model: minimax-m2.7
effort: medium
---

# Finish Development

**Core principle:** Verify before claiming done. Clean up properly. Give user clear options.

<orchestrator_role>
<rule>YOU DO NOT RUN TESTS YOURSELF.</rule>
<rule>YOU DO NOT VERIFY CODE YOURSELF.</rule>
<rule>YOU DELEGATE final verification to a validation agent via the Task tool.</rule>
<rule>You PRESENT options and EXECUTE the user's choice — that's it.</rule>
</orchestrator_role>

<triggers>
<trigger>All implementation todos complete</trigger>
<trigger>Code review approved</trigger>
<trigger>Ready to merge or create PR</trigger>
<trigger>Need to close out a development branch</trigger>
</triggers>

<prerequisites>
<prerequisite>All implementation todos complete</prerequisite>
<prerequisite>All validation/review todos complete</prerequisite>
<prerequisite>No pending issues or blockers</prerequisite>
</prerequisites>

<agent_discovery required="true">
Check Task tool's subagent_type options for available agents.
<agent>validator</agent>
</agent_discovery>

## Step 1: Final Verification

<dispatch agent="validator">Final verification before shipping. Run all tests fresh. Check: all tests pass, no uncommitted changes, branch is up to date, all requirements met. Report: pass/fail with details.</dispatch>

## Step 2: Summary Report

After validator returns, present a summary to the user:

<summary_format>
<field name="Task">[original task description]</field>
<field name="Changes">[file1]: [what changed], [file2]: [what changed]</field>
<field name="Tests">All passing (validator confirmed)</field>
<field name="Commits">[commit messages]</field>
</summary_format>

## Step 3: Present Options

<options>
<option id="1">Merge locally — Merge to [base branch], delete feature branch</option>
<option id="2">Create PR — Push and create pull request</option>
<option id="3">Keep as-is — Leave branch intact, no merge</option>
<option id="4">Discard — Delete branch and all changes</option>
</options>

## Step 4: Execute User Choice

<execute_option id="1" name="Merge locally">
<command>git checkout [base branch] &amp;&amp; git pull &amp;&amp; git merge [feature branch] &amp;&amp; git branch -d [feature branch]</command>
<action>Run tests to verify.</action>
</execute_option>

<execute_option id="2" name="Create PR">
<command>git push -u origin [feature branch]</command>
<action>gh pr create with summary from Step 2.</action>
<action>Report PR URL.</action>
</execute_option>

<execute_option id="3" name="Keep as-is">
<action>Report current branch name and state.</action>
</execute_option>

<execute_option id="4" name="Discard">
<action>Require user to type "discard" to confirm.</action>
<action>Then delete branch.</action>
</execute_option>

<on_rejection>
If user requests changes after seeing summary:
<step>Do NOT mark Phase 6 complete</step>
<step>Identify which phase needs revisiting</step>
<step>Route back to the appropriate skill</step>
<step>Return to Phase 6 when ready</step>
</on_rejection>

<todo>
<task>Step 0: Discover available agents</task>
<task>Step 1: Final verification — dispatch validator agent</task>
<task>Step 2: Present summary report</task>
<task>Step 3: Present options to user</task>
<task>Step 4: Execute user's choice</task>
</todo>

<question_relay>
When a delegated agent returns with a question instead of a deliverable:
<step>Detect: The agent response contains a question or "need clarification" — not a completed deliverable.</step>
<step>Relay: Present the agent's question to the user. Add context: which step, which agent.</step>
<step>Wait: Do not proceed, guess, or answer on the user's behalf.</step>
<step>Resume: Use the Task tool's resume parameter with the agent's ID to continue with the user's answer.</step>
<step>Repeat: If the resumed agent asks again, relay again.</step>
<never>Answer an agent's question yourself, skip it, or re-spawn a new agent losing context.</never>
</question_relay>

<red_flags>
<flag>You are running tests yourself instead of dispatching a validator agent</flag>
<flag>You presented options before the validator confirmed everything passes</flag>
<flag>You executed "discard" without requiring user to type "discard"</flag>
<flag>You skipped the summary report</flag>
<flag>You skipped agent discovery</flag>
</red_flags>
