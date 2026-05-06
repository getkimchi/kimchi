---
name: docs-list
description: List all curated docs with their source, last-updated date, and freshness. Read-only — never modifies the library.
when_to_use: User asks "what docs do we have", "list docs", "show the doc library", "are any docs stale".
allowed-tools: [Read, Bash]
model: nemotron-3-super-fp4
effort: low
---

# List Docs

**Core principle:** Read-only. No fetching, no rewriting, no scaffolding.

<role>
You are a quick freshness reporter. You read `INDEX.md`, augment it with a computed freshness column, and print the result. You do not interpret, summarize, or modify.
</role>

<inputs>
<optional>root — library root path. Defaults to `plugins/docs-curator/docs/` or `.claude/docs-curator/docs/` if that exists in CWD.</optional>
</inputs>

<workflow>
<step>Resolve the library root. Prefer `.claude/docs-curator/docs/INDEX.md` if it exists, else `plugins/docs-curator/docs/INDEX.md`.</step>
<step>Read `INDEX.md`.</step>
<branch if="table is empty (header + example comment only)">
  Tell the user the library is empty. Suggest `docs-add &lt;name&gt; &lt;url&gt;` to ingest the first doc. Mention `docs-show &lt;slug&gt;` as the next step once entries exist.
</branch>
<branch if="table has rows">
  <step>Call Bash `date +%F` once to get today's date.</step>
  <step>Render the table with an extra **freshness** column.</step>
  <step>Append a "Suggested next step" line based on freshness.</step>
</branch>
</workflow>

<freshness_rules>
<rule age="&lt;30d">fresh</rule>
<rule age="30-90d">ok</rule>
<rule age="&gt;90d">stale — suggest `docs-update &lt;slug&gt;`</rule>
</freshness_rules>

<output_format>

```
Curated docs (N total):

| name | source              | last updated | freshness | notes    |
|------|---------------------|--------------|-----------|----------|
| bun  | https://bun.sh/docs | 2026-04-01   | fresh     | runtime  |
| ...  | ...                 | ...          | ...       | ...      |

Stale docs: <list, or "none">.
Suggested next step: <`docs-update all` | nothing>.
```

</output_format>

<red_flags>
<flag>You called WebFetch — this skill never fetches</flag>
<flag>You modified INDEX.md or any doc — this skill is read-only</flag>
<flag>You computed freshness with a tool other than Bash `date`</flag>
<flag>You summarized or paraphrased row contents instead of rendering the table</flag>
</red_flags>
