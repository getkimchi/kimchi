# MCP Tool Selector Design

**Goal:** Per-turn automatic tool selection for Pi — injects only the relevant MCP tools into the LLM's context before each model call, reducing context bloat and improving tool selection accuracy.

---

## Problem

Pi's pi-mcp-adapter exposes 176 tools across 4 MCP servers via a single `mcp` proxy tool. The agent must manually search and discover tools, costing extra turns and context. Loading all 176 tools directly would bloat the context window before any real work begins.

## Solution

A standalone Pi extension (`tool-selector.ts`) that intercepts each user input, runs BM25 scoring over the tool catalog, and calls `pi.setActiveTools()` with the top-K results before the model call. The `mcp` proxy is always included as fallback.

---

## Architecture

Single TypeScript file: `~/.pi/agent/extensions/tool-selector.ts`. No build step, no npm dependencies. Loaded by Pi at runtime alongside pi-mcp-adapter.

**Two extension events used:**
- `session_start` — fetch live tool catalog via `mcp({ search: ".", regex: true })`, build BM25 index
- `input` — score current text + rolling window against index, call `setActiveTools`

**Does not touch pi-mcp-adapter.** Reads tool metadata by calling the `mcp` tool directly — `details` contains `[{toolName, description, schema}]` for all tools.

---

## Tool Index

On `session_start`, the extension calls `mcp({ search: ".", regex: true })` which returns structured tool metadata in `result.details` as `[{toolName, description, schema}]`. For each tool, it builds an extended description for BM25 indexing:

```
indexText = name + " " + description + " " + flattenedSchemaParams
```

Where `flattenedSchemaParams` is a space-separated string of all `schema.properties` parameter names and their descriptions (from the `schema` field in `mcp({search})` details). For resource tools (those with `resourceUri` and no `schema`), this field is empty string. This synthesizes "use cases" from the schema without requiring external authors to add any new fields.

Example — `get_node_metrics(cluster_id, metric_type, time_range)` → index text includes `"cluster_id metric_type time_range"`, so "cluster performance" query matches.

The index is an in-memory array of:
```ts
interface ToolEntry {
  name: string        // registered tool name (e.g. "castai_prod_master__get_node_metrics")
  server: string      // server name
  indexText: string   // name + description + schema params (for BM25)
}
```

---

## Selection Strategy

```ts
type SelectionStrategy = (tools: ToolEntry[], query: string) => ToolEntry[]
```

Default implementation: BM25 with stop-word filtering and basic stemming (strip common suffixes: -ing, -ed, -s). Scores each tool's `indexText` against the query, returns top-K by score.

The strategy is a plain function — swapping it means replacing one function reference. No plugin system needed.

---

## Per-Turn Flow

On each `input` event:

1. Append `event.text` to a rolling message window (stores last N turns of interleaved user + assistant texts in chronological order; N=3 means up to 3 user messages and 3 assistant messages = 6 entries max, oldest dropped from the front)
2. Build query string: concatenate window contents
3. Run `SelectionStrategy(index, query)` → top-K tools (default K=5)
4. Call `pi.setActiveTools([...selectedToolNames, "mcp"])` — takes `string[]` of tool names

The `mcp` proxy tool is always appended regardless of selection result. If the selector returns nothing (empty query, no matches), only `mcp` is active.

The rolling window is updated with assistant message text on `message_end` events (role === "assistant").

---

## Configuration

Hardcoded defaults:

| Parameter | Default | Meaning |
|---|---|---|
| `topK` | `5` | Max tools injected per turn |
| `windowSize` | `3` | Turns of history scored (user + assistant) |

No config file. These can be made configurable later without changing the interface.

---

## Data Flow

```
session_start
  └── mcp({search:".", regex:true}) → details: [{toolName, description, schema}]
  └── build ToolEntry[] index (name + description + schema params)

input event (user message)
  └── prepend to rolling window
  └── BM25(index, window text) → top-K ToolEntry[]
  └── setActiveTools([...names, "mcp"])
  └── model call proceeds with lean tool set

message_end (assistant)
  └── append assistant text to rolling window
```

---

## Error Handling

- If `mcp({search:".", regex:true})` fails on `session_start`: log warning, leave `setActiveTools` uncalled (Pi uses whatever was active before, likely just `mcp`)
- If BM25 scores all zero: only `mcp` is active — agent falls back to manual search, same as current behavior
- If `setActiveTools` throws: log error, do not crash — agent continues with previous active set

---

## What This Does Not Do

- No mid-session tool catalog refresh (static after `session_start`; add later if needed)
- No embedding/semantic search (BM25 only for now; strategy is swappable)
- No tool pinning (agent can always use `mcp` fallback)
- No config file (hardcoded defaults)

---

## File Map

| Action | Path |
|---|---|
| Create | `~/.pi/agent/extensions/tool-selector.ts` |

---

## Reference

- Ticket: [LLM-1249](https://castai.atlassian.net/browse/LLM-1249)
- Pi ExtensionAPI events: `session_start`, `input`, `message_end`
- Pi `setActiveTools`: filters which registered tools are visible to LLM per turn
- Anthropic tool search article: https://www.anthropic.com/engineering/advanced-tool-use
