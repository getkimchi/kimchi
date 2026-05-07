# Tool Selector Prompting Fix Design

**Goal:** Fix the tool-selector extension so the model actually calls MCP tools after `search_tool_bm25` activates them, instead of floundering with shell commands or mcp-cli.

**Ticket:** [LLM-1249](https://castai.atlassian.net/browse/LLM-1249)

---

## Root Cause

`setActiveTools()` updates the tool set for the **next** model turn, not the current one. When the model calls `search_tool_bm25` mid-turn, the activated tools' schemas aren't available until the next `agent.prompt()` call. The model sees "Activated: X" in the search result text but has no tool schema for X in its current context, so it improvises (shell commands, mcp-cli, etc.).

The fix is purely prompting: tell the model about the two-turn workflow explicitly.

---

## Changes

### 1. System Prompt — `before_agent_start` hook

**File:** `~/.pi/agent/extensions/tool-selector.ts`, `before_agent_start` handler

Replace the current single-line injection:

```
MCP servers available (call search_tool_bm25 to activate tools before using them): {serverNames}.
```

With:

```
## MCP Tool Discovery

You have access to MCP servers: {serverNames}. Their tools are NOT visible yet.

Workflow:
1. Call search_tool_bm25({ query: "keywords" }) to find and activate relevant tools
2. After search completes, the activated tools become available as direct tool calls on your NEXT response
3. After calling search_tool_bm25, end your response. The tools become available on your next turn.
```

### 2. Search Result Output — `search_tool_bm25` execute function

Strip output to essentials. Current format includes lifecycle noise (pending, not ready, full active listing). New format:

```
Activated (2):
  grafana_prod_master_query_loki_logs(required: datasourceUid, logql)
  grafana_prod_master_list_loki_label_names(required: datasourceUid)

These tools are now available as direct tool calls in your next response.
```

Changes:
- Drop "Pending (MCP server initializing)" lines
- Drop full "Active MCP tools" listing (model sees schemas next turn anyway)
- Add nudge: "available as direct tool calls in your next response"
- Keep activated + pruned counts (pruned is useful context for the model)

### 3. Output Truncation — `tool_result` hook

Already implemented. Keep as-is with current defaults (`maxOutputChars: 20_000`, `tailChars: 5_000`). Tail-preserving strategy is correct for log/query outputs. Configurable via `~/.pi/agent/tool-selector.json`.

---

## Consensus Notes

Reviewed with Gemini 3 Pro (neutral) and Gemini 2.5 Flash (adversarial).

**Adopted:** Replace negative prohibition ("Do NOT attempt...") with positive stop directive ("end your response"). Models respond better to concrete actions than prohibitions.

**Noted for future:** Flash argues Approach B (auto-search on input) deserves urgent reconsideration since single-turn activation is superior UX. Both models recommend Approach C (hybrid) on the roadmap. Primary failure mode to monitor: model hallucinating tool calls in plain text instead of waiting for schemas.

---

## What This Does Not Do

- No lifecycle concerns in prompt (not-ready tools, shell command warnings) — add later if lean prompt proves insufficient
- No mid-turn tool activation (would require pi-mono core changes)
- No auto-search on input (Approach B/C — revisit if two-turn workflow is too clunky)

---

## File Map

| Action | Path |
|---|---|
| Modify | `~/.pi/agent/extensions/tool-selector.ts` |

No other files touched.
