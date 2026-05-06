---
name: docs-scaffold
description: Generate a new agent or skill that is grounded in a curated doc. The generated file references the doc's local path so updates propagate automatically.
when_to_use: User wants to create an agent or skill that knows a specific framework — "make me a Bun expert agent", "scaffold a Drizzle migration skill", "build an agent that uses the TanStack Query docs".
argument-hint: [agent|skill] [doc-name] [new-name]
allowed-tools: [Task, Read]
model: minimax-m2.7
effort: medium
---

# Scaffold From Doc

**Core principle:** Generated agents/skills **reference** the doc via its local path — they never inline content. That way `docs-update` stays load-bearing: update the doc once, every grounded agent/skill sees the new version.

<orchestrator_role>
<rule>YOU DO NOT WRITE THE AGENT/SKILL FILE YOURSELF.</rule>
<rule>YOU DELEGATE to the `docs-curator` agent via the Task tool.</rule>
<rule>You VERIFY the doc exists, PICK the right scaffold operation, GATE on user confirmation, and REPORT — nothing else.</rule>
</orchestrator_role>

<triggers>
<trigger>User wants an agent/skill specialized in a specific framework they've curated</trigger>
<trigger>User says "make me a Bun expert", "scaffold a React hooks skill", "build an X agent from the docs"</trigger>
</triggers>

<do_not_use>
<condition>The doc is not yet curated — route to `docs-add` first</condition>
<condition>A file with the target path already exists — refuse, never overwrite</condition>
</do_not_use>

<inputs>
<required name="kind">`agent` or `skill`</required>
<required name="doc-name">Slug of an existing doc in INDEX.md</required>
<required name="new-name">Kebab-case name for the new agent/skill</required>
<optional name="target-plugin">Defaults to the user's current project (`.claude/agents/` or `.claude/skills/`). Named plugins write under `plugins/&lt;name&gt;/`.</optional>
<optional name="purpose">One-line hint for what the generated agent/skill should specialize in</optional>
</inputs>

<phase number="1" name="preflight">
<dispatch agent="docs-curator">
Operation: `preflight` for scaffold.

1. Confirm `&lt;ROOT&gt;/{{DOC_NAME}}/` exists and is registered in `INDEX.md`.
2. If not, DO NOT scaffold. Tell the orchestrator to run `docs-add` first.
3. If yes, return the doc's `SUMMARY.md` contents so the orchestrator can show the user what the scaffold will be grounded in.
4. Also return the resolved target path so the user can confirm it before any write.
</dispatch>
</phase>

<gate requires="user_confirmation">
<present>The doc SUMMARY (from the preflight dispatch)</present>
<present>The resolved target path:
  <option kind="agent">`.claude/agents/{{NEW_NAME}}.md` (default) or `plugins/{{TARGET_PLUGIN}}/agents/{{NEW_NAME}}.md`</option>
  <option kind="skill">`.claude/skills/{{NEW_NAME}}/SKILL.md` (default) or `plugins/{{TARGET_PLUGIN}}/skills/{{NEW_NAME}}/SKILL.md`</option>
</present>
<action>Ask: "Scaffold `{{NEW_NAME}}` grounded in `{{DOC_NAME}}` at &lt;path&gt;? Purpose: {{PURPOSE}}."</action>
<action>Wait for explicit `yes`. Do not scaffold without it.</action>
</gate>

<phase number="2" name="generate">
<dispatch agent="docs-curator">
Operation: `scaffold-{{KIND}}`
Doc: {{DOC_NAME}}
New name: {{NEW_NAME}}
Target: {{TARGET_OR_DEFAULT}}
Purpose: {{PURPOSE}}

Hard requirements:
1. Write the file at the resolved target path. Refuse to overwrite an existing file.
2. Frontmatter MUST include: `name`, `description` (mention the tool/framework by name); for agents add `tools` + `model`; for skills add `when_to_use` + `allowed-tools`.
3. Body MUST include a `## Grounding` section telling the agent/skill to read `&lt;ROOT&gt;/{{DOC_NAME}}/SUMMARY.md` before acting, and `README.md` for deep questions. Do NOT inline doc content.
4. Report: file path written, frontmatter summary, and a reminder to run `generate-commands.sh` if the target plugin auto-generates commands.
</dispatch>
</phase>

<todo>
<task>Validate inputs (kind ∈ {agent, skill}, new-name is kebab-case)</task>
<task>Phase 1: preflight dispatch → doc exists check + SUMMARY preview + resolved target path</task>
<task>GATE: present preview + path → WAIT for yes</task>
<task>Phase 2: scaffold dispatch</task>
<task>Remind user about generate-commands.sh if writing into a plugin that uses it</task>
</todo>

<question_relay>
If the agent returns a question during preflight (e.g. "doc exists but has no SUMMARY.md — regenerate?"), relay to the user before proceeding.
</question_relay>

<red_flags>
<flag>You wrote the agent/skill file yourself instead of delegating</flag>
<flag>The generated file inlines doc content instead of referencing `SUMMARY.md` / `README.md`</flag>
<flag>You scaffolded without confirming the doc exists in INDEX.md</flag>
<flag>You overwrote an existing agent/skill file</flag>
<flag>You proceeded past the gate without user confirmation</flag>
<flag>The generated description does not mention the tool/framework by name (router won't find it)</flag>
</red_flags>
