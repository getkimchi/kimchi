---
name: docs-add
description: Add a new tool/framework's documentation to the curated library. Fetches from a user-provided source URL, distills it to local Markdown, and registers it in the index.
when_to_use: User wants to ingest a new library/tool/framework's docs — phrases like "add the Bun docs", "grab the Drizzle docs", "pull in the TanStack Query docs", "ingest <url>".
argument-hint: [tool-name] [source-url]
allowed-tools: [Task, Read]
model: minimax-m2.7
---

# Add Doc

**Core principle:** One slug, one source, one row in the index. Never half-commit.

<orchestrator_role>
<rule>YOU DO NOT FETCH OR WRITE FILES YOURSELF.</rule>
<rule>YOU DELEGATE the entire add operation to the `docs-curator` agent via the Task tool.</rule>
<rule>You PARSE the request, DISPATCH, and REPORT the result — nothing else.</rule>
</orchestrator_role>

<triggers>
<trigger>User names a new tool/framework and provides a source URL</trigger>
<trigger>User says "ingest", "add", "pull in", "grab", "curate" + a library name</trigger>
<trigger>User pastes a doc root URL and asks to save it</trigger>
</triggers>

<do_not_use>
<condition>Slug already exists in INDEX.md (use `docs-update` instead)</condition>
<condition>User did not provide a source URL — STOP and ask</condition>
<condition>User wants to scaffold an agent/skill (use `docs-scaffold` — which may call this first)</condition>
</do_not_use>

<inputs>
<required name="tool-name">Lowercase kebab-case slug (e.g. `bun`, `tanstack-query`)</required>
<required name="source-url">The doc URL or doc root the user provided</required>
<optional name="scope">Sub-section hint (e.g. "hooks only" for React) — pass through to agent</optional>
</inputs>

<dispatch agent="docs-curator">
Operation: `add`
Slug: {{TOOL_NAME}}
Source: {{SOURCE_URL}}
Scope: {{SCOPE_OR_ALL}}

Follow your `add` operation exactly:
1. Refuse if the slug exists in `INDEX.md` — tell the user to use `docs-update` instead.
2. Create `&lt;ROOT&gt;/{{TOOL_NAME}}/` with `README.md`, `SUMMARY.md`, `SOURCE.md` (SOURCE.md matching the strict YAML schema).
3. Append a sorted row to `INDEX.md`.
4. Report: slug, files written, source URLs fetched, and a 1-line summary of what this tool is.
</dispatch>

<gate requires="source_url">
If the user did not supply a source URL, STOP and ask for one. Do NOT guess a URL from training data.
</gate>

<todo>
<task>Parse tool-name and source-url from the request</task>
<task>Verify source URL was provided (gate)</task>
<task>Dispatch docs-curator agent with `add` operation</task>
<task>Report result (slug, files written, source)</task>
</todo>

<question_relay>
If the docs-curator agent returns a clarifying question (e.g. "full React docs or just hooks?"), relay it verbatim to the user, wait for the answer, and resume the agent with the response. Never answer on the user's behalf.
</question_relay>

<red_flags>
<flag>You fetched the URL yourself instead of delegating</flag>
<flag>You wrote files outside the resolved library root</flag>
<flag>You guessed a source URL the user did not provide</flag>
<flag>You created the doc directory but forgot to update INDEX.md (agent must do both in one turn)</flag>
<flag>You skipped the source-url gate</flag>
</red_flags>
