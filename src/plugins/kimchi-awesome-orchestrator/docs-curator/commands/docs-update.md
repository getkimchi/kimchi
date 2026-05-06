---
name: docs-update
description: Refresh one or all curated docs by re-fetching from their recorded sources. Diffs new content against the stored copy and rewrites only what changed.
when_to_use: User asks to update, refresh, re-pull, sync, or check freshness of docs. Also triggered by phrases like "update all docs", "refresh the Bun docs", "are these docs stale".
argument-hint: [tool-name | all]
allowed-tools: [Task, Read]
model: minimax-m2.7
effort: medium
---

# Update Docs

**Core principle:** A doc is a contract with every agent/skill that references it. Update atomically or not at all.

<orchestrator_role>
<rule>YOU DO NOT FETCH OR DIFF FILES YOURSELF.</rule>
<rule>YOU DELEGATE update to the `docs-curator` agent via the Task tool.</rule>
<rule>For `all`, you may dispatch ONE agent that iterates, OR dispatch multiple agents in parallel if the list is large (>5 docs). Never iterate from the orchestrator's own tool calls.</rule>
<rule>Reading `INDEX.md` directly IS allowed here — it's the manifest, not a doc. You need the slug list to dispatch parallel agents.</rule>
</orchestrator_role>

<triggers>
<trigger>User asks to refresh / update / sync / re-pull one or more docs</trigger>
<trigger>User asks "are these docs stale"</trigger>
<trigger>docs-list flagged stale entries and the user wants action</trigger>
</triggers>

<inputs>
<required name="target">A slug from INDEX.md, or the literal word `all`</required>
</inputs>

<dispatch_strategy name="sequential" condition="target is a single slug">
<dispatch agent="docs-curator">
Operation: `update`
Target: {{SLUG}}

Follow your `update` operation:
1. Parse `SOURCE.md` YAML frontmatter to recover `sources`, `fetch_strategy`, `followed_paths`.
2. Re-`WebFetch` the same sources. Diff against current `README.md`.
3. If changed: rewrite `README.md` + `SUMMARY.md`, bump `fetched_at` in `SOURCE.md`, update `last updated` in `INDEX.md`.
4. If unchanged: bump `fetched_at` only.
5. Report: changed/unchanged, which sections shifted, any new footguns worth noting.
</dispatch>
</dispatch_strategy>

<dispatch_strategy name="sequential" condition="target is `all` and index has ≤5 rows">
<dispatch agent="docs-curator">
Operation: `update all`

Iterate every row in `INDEX.md`. For each slug, run the full `update` operation. Report one line per doc: `&lt;slug&gt;: changed | unchanged | failed (&lt;reason&gt;)`. Produce a final summary at the end.
</dispatch>
</dispatch_strategy>

<dispatch_strategy name="parallel" instruction="Send ALL dispatches below as multiple Task tool calls in ONE single message" condition="target is `all` and index has &gt;5 rows">
First read `INDEX.md` directly to get the slug list, then:
<dispatch agent="docs-curator">Operation: `update`. Target: {{SLUG_1}}. Follow the update operation. Report changed/unchanged + notable diffs.</dispatch>
<dispatch agent="docs-curator">Operation: `update`. Target: {{SLUG_2}}. Follow the update operation. Report changed/unchanged + notable diffs.</dispatch>
<!-- one dispatch per slug, all in a single message -->
</dispatch_strategy>

<synthesis>
After all agents return, build one status table:

| slug | status | notable changes |
|------|--------|-----------------|
| bun  | changed   | new `--watch` flag docs in CLI section |
| react | unchanged | fetched_at bumped only |
| ...   | ...       | ... |
</synthesis>

<todo>
<task>Resolve target — slug or `all`</task>
<task>If parallel: read INDEX.md to extract slug list</task>
<task>Dispatch docs-curator agent(s)</task>
<task>Synthesize results into the status table</task>
</todo>

<question_relay>
If any agent returns a question (e.g. "source now requires auth, what credentials?"), relay it to the user. Other parallel agents that returned clean results CAN continue being processed.
</question_relay>

<red_flags>
<flag>You WebFetched a URL yourself</flag>
<flag>You rewrote a doc without bumping `fetched_at` in SOURCE.md</flag>
<flag>You updated content but forgot to update `last updated` in INDEX.md</flag>
<flag>You dispatched parallel updates one at a time instead of in a single message</flag>
<flag>You parsed SOURCE.md as prose instead of as YAML frontmatter</flag>
</red_flags>
