---
name: docs-remove
description: Remove a doc from the curated library. Before deleting, surfaces every agent/skill that still references it so the user can confirm or refactor first.
when_to_use: User asks to remove, delete, drop, or uncurate a doc. Removal is destructive — this skill always confirms first.
argument-hint: [tool-name]
allowed-tools: [Task, Read]
model: minimax-m2.7
---

# Remove Doc

**Core principle:** Deleting a doc breaks every agent/skill that references its path. Always surface the blast radius before cutting.

<orchestrator_role>
<rule>YOU DO NOT DELETE FILES YOURSELF.</rule>
<rule>YOU DELEGATE to the `docs-curator` agent via the Task tool.</rule>
<rule>You MUST gate the actual deletion behind explicit user confirmation after the blast-radius report.</rule>
<rule>Two dispatches are required: first for the report, second (only after `yes`) for the actual delete.</rule>
</orchestrator_role>

<triggers>
<trigger>User asks to remove / delete / drop / uncurate a doc</trigger>
<trigger>User wants to clean up stale entries listed by docs-list</trigger>
</triggers>

<inputs>
<required name="tool-name">The slug to remove</required>
</inputs>

<phase number="1" name="blast-radius report">
<dispatch agent="docs-curator">
Operation: `remove {{SLUG}}` — **report phase only, do NOT delete yet**.

1. Confirm `&lt;ROOT&gt;/{{SLUG}}/` exists and is registered in `INDEX.md`.
2. `Grep` across `plugins/` and the user project's `.claude/` for references to `{{SLUG}}` within doc paths.
3. Return: "doc exists: yes/no", "references found: N files", and the full file list.
4. DO NOT delete anything yet.
</dispatch>
</phase>

<gate requires="user_confirmation">
<present>The blast-radius report returned by the agent</present>
<action>Ask: "Delete `{{SLUG}}` and remove its index row? N agent(s)/skill(s) reference it and will break. Type `yes` to proceed, or name a refactor first."</action>
<action>DO NOT proceed without an explicit `yes`.</action>
</gate>

<phase number="2" name="actual delete">
<dispatch agent="docs-curator">
Operation: `remove {{SLUG}}` — **delete phase, user confirmed**.

1. `rm -rf &lt;ROOT&gt;/{{SLUG}}/`
2. Remove the `{{SLUG}}` row from `INDEX.md`.
3. Report: deleted directory path, index row removed, and the list of referencing files the user will now need to refactor.
</dispatch>
</phase>

<todo>
<task>Dispatch agent for blast-radius report (phase 1)</task>
<task>GATE: present report → WAIT for explicit user confirmation</task>
<task>Dispatch agent for actual delete (phase 2)</task>
<task>Report final state + broken references list</task>
</todo>

<red_flags>
<flag>You deleted the doc in phase 1 instead of just reporting</flag>
<flag>You proceeded past the gate without an explicit `yes`</flag>
<flag>You deleted the directory but forgot to remove the INDEX.md row</flag>
<flag>You ran `rm` yourself via Bash instead of delegating</flag>
<flag>You skipped phase 1 and went straight to delete</flag>
</red_flags>
