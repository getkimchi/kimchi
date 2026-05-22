export const SCOPING_EXPLORE_TOKEN_BUDGET = 120_000

export const SCOPING_DISCOVERY_GUIDANCE = `<phase_0_inventory required="true" before="any filesystem read, list, grep, bash, or codebase discovery">
First response action: print a concise inventory of all available skills and subagent types so the user can see what delegation surface exists.
Use the visible skill list or a skill-listing tool if one is available; if skills are not exposed in this environment, say that explicitly instead of inventing names.
For subagents, inspect the Agent tool subagent_type options or the available-subagent prompt section.
Do not call List, Read, Grep, Bash, or any codebase discovery tool before this inventory is printed.
</phase_0_inventory>

<discovery_sequence required="true">
For broad improvement/audit/planning requests over an existing codebase, even when the user asks with a simple prompt:
1. Do a small direct scan only to identify the project shape. This means file listing plus concise manifest/README/package/config reads and, if needed, targeted searches or short entrypoint snippets.
2. Do not use unbounded Read calls on implementation, UI, or style files before the delegation checkpoint. For source-like files, first get the file's line count or tool-reported length, then read at most a short snippet, about 60 lines or less, unless a targeted search points to a narrow range.
3. Only read an implementation/UI/style file end-to-end during the direct scan when the line count proves it is small enough to be a snippet-sized file and the read is narrowly justified.
4. If a file is longer than about 120 lines, or you do not yet know exactly which symbol/range you need, do not read it end-to-end during the direct scan. Delegate first.
5. Immediately spawn 1-4 narrow Explore subagents for independent areas that could change the recommendations. One Explore subagent is valid when there is only one broad unknown; use 2-4 only when there are genuinely independent areas.
6. Wait for their results.
7. Synthesize findings before calling propose_ferment_scoping.
</discovery_sequence>

Explore subagent contract:
- subagent_type: "Explore" (if not available, use the closest fitting subagent type)
- start with token_budget: ${SCOPING_EXPLORE_TOKEN_BUDGET}; increase only if the user explicitly asks or the missing fact is genuinely plan-blocking
- run_in_background: true when multiple independent unknowns exist
- Prefer several narrow Explore probes over one broad "understand the whole project" scan.

Good Explore areas:
- file map/entry points
- UI/general flow
- background/storage/API flow
- security/risk/refactor opportunities
- nearby related projects
- repo-specific architecture patterns

Direct-read boundary:
After Phase 0 inventory, the only allowed direct scan before the delegation checkpoint is: list/find file names, read README/manifest/package/config files, targeted searches, and at most short entrypoint snippets. The next action after that scan is Agent, not more Read calls.
Use direct reads for narrow facts and short snippets only; use Explore for broader areas that could change the plan.
Do not "round out the initial scan" by reading lib/source/style files before delegation.
Forbidden pattern: reading entire implementation, UI, or style files before Explore delegation, then claiming direct analysis was sufficient. This is still a violation even if you later spawn Explore subagents.

Self-correction:
If you accidentally read an entire implementation, UI, or style file before the delegation checkpoint, stop direct reads immediately. Do not analyze further, do not read more files, and do not propose scoping yet. Spawn the required Explore subagent(s), wait for results, then synthesize.

Skip rule:
Do not skip this checkpoint just because the direct scan feels sufficient. Skip only when the task is simple/greenfield or the user explicitly asks not to delegate; record that reason in assumptions.`
