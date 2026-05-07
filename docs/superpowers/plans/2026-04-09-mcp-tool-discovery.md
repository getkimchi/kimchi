# MCP Tool Discovery Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current per-turn BM25 gating in `tool-selector.ts` with an additive+decay discovery model: all MCP tools start hidden, the LLM calls `search_tool_bm25` to activate relevant tools, and each search call re-scores currently active MCP tools, pruning those that fall below a threshold.

**Architecture:** Single TypeScript file `~/.pi/agent/extensions/tool-selector.ts` (replacing current). On `session_start`, read `~/.pi/agent/mcp-cache.json`, build a weighted BM25 index, and call `setActiveTools([...builtins])` to hide all MCP tools. Register a `search_tool_bm25` tool that: (1) searches the full index for `query`, (2) re-scores currently active MCP tools against `query` and drops those below `PRUNE_THRESHOLD`, (3) activates the top-K new matches, (4) calls `setActiveTools([...builtins, ...activeMcpTools])`. Works on top of pi-mcp-adapter which handles actual MCP connections and tool execution.

**Tech Stack:** TypeScript (no build step, no npm deps), Pi `ExtensionAPI` (`@mariozechner/pi-coding-agent`), BM25 with field weights (name×6, description×2, schema keys×1), camelCase-aware tokenizer, Node.js `fs`.

---

## Background: How Pi + pi-mcp-adapter work

- `pi-mcp-adapter` reads `~/.pi/agent/mcp.json`, connects to MCP servers, and registers direct tools via `pi.registerTool()` when a server has `"directTools": true`. It also writes `~/.pi/agent/mcp-cache.json` with tool schemas.
- Registered tool names: `{serverName}_{toolName}` (single underscore, from `formatToolName` in pi-mcp-adapter). E.g. `sqlite_list_tables`, `castai_prod_master_get_node_metrics`.
- `pi.registerTool()` makes a tool visible by default. `pi.setActiveTools(names)` restricts the active set to exactly `names`. Calling `setActiveTools` with a name not in the registered set is silently ignored.
- `pi.getAllTools()` returns all registered tools (builtins + pi-mcp-adapter direct tools + our own registered tools).
- Builtin tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `mcp`, `subagent_create`, `subagent_continue`, `subagent_remove`, `subagent_list`.

## Cache format (`~/.pi/agent/mcp-cache.json`)

```json
{
  "version": 1,
  "servers": {
    "sqlite": {
      "tools": [
        {
          "name": "list_tables",
          "description": "List all tables in the database",
          "inputSchema": {
            "type": "object",
            "properties": {}
          }
        }
      ]
    }
  }
}
```

Registered name = `sqlite_list_tables` (serverName + `_` + toolName).

---

## File Map

| Action | Path |
|---|---|
| Replace | `~/.pi/agent/extensions/tool-selector.ts` |

No other files touched.

---

## Key Constants

```typescript
const TOP_K = 8;               // max tools activated per search call
const PRUNE_THRESHOLD = 0.1;   // active MCP tools scoring below this are deactivated
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const FIELD_WEIGHTS = { name: 6, description: 2, schemaKey: 1 };
```

---

## BM25 Differences from current tool-selector.ts

| Aspect | Current | New |
|---|---|---|
| Tokenizer | Split on `[^a-z0-9]`, stem, filter stop words | Split on non-alphanumeric + camelCase split, lowercase, no stop words, no stemming |
| Field weights | Flat (name+description+schema all equal) | Weighted: name×6, description×2, schema keys×1 |
| TF input | `name + description + flattenSchema` concatenated | Per-field weighted TF (add weight to each token from that field) |
| IDF | Standard Robertson | Same |
| Scoring | Returns sorted `ToolEntry[]` | Returns `{entry, score}[]` so caller can threshold |

### New tokenizer

```typescript
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")  // camelCase → "camel Case"
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0);
}
```

### New weighted TF document building

```typescript
interface BM25Doc {
  entry: ToolEntry;
  termFreq: Map<string, number>;  // weighted
  length: number;                  // sum of all weighted freqs
}

function addWeightedTokens(tf: Map<string, number>, text: string, weight: number): void {
  for (const token of tokenize(text)) {
    tf.set(token, (tf.get(token) ?? 0) + weight);
  }
}

function buildDoc(entry: ToolEntry): BM25Doc {
  const tf = new Map<string, number>();
  addWeightedTokens(tf, entry.name, FIELD_WEIGHTS.name);
  addWeightedTokens(tf, entry.description, FIELD_WEIGHTS.description);
  for (const key of entry.schemaKeys) {
    addWeightedTokens(tf, key, FIELD_WEIGHTS.schemaKey);
  }
  const length = Array.from(tf.values()).reduce((s, v) => s + v, 0);
  return { entry, termFreq: tf, length };
}
```

---

## New ToolEntry shape

```typescript
interface ToolEntry {
  name: string;        // registered name, e.g. "sqlite_list_tables"
  server: string;      // server name, e.g. "sqlite"
  description: string; // raw description (for weighted indexing)
  schemaKeys: string[]; // parameter names from inputSchema.properties
}
```

---

## search_tool_bm25 behavior

Parameters: `{ query: string, limit?: number }` (limit defaults to TOP_K)

On each call:
1. Tokenize `query`
2. Score ALL entries in index → `{entry, score}[]`
3. **Prune**: for each currently active MCP tool, if its score < PRUNE_THRESHOLD → remove from active set
4. **Activate**: take top-K from scored results, excluding already-active tools, add to active set
5. Call `pi.setActiveTools([...builtins, ...activeMcpTools])`
6. Return text listing activated and pruned tools

Active MCP set is maintained in a `Set<string>` in extension closure, persists across search calls for the session.

---

## Task 1: BM25 with Field Weights

**Files:**
- Replace: `~/.pi/agent/extensions/tool-selector.ts`

Replace the entire file with the new implementation up to and including `scoreBM25`. Do not add the extension export yet.

- [ ] **Step 1: Write the new file with types, constants, tokenizer, and BM25**

Write `~/.pi/agent/extensions/tool-selector.ts`:

```typescript
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---- Types ----------------------------------------------------------------

interface ToolEntry {
  name: string;         // registered name, e.g. "sqlite_list_tables"
  server: string;       // server name, e.g. "sqlite"
  description: string;  // raw description string
  schemaKeys: string[]; // parameter names from inputSchema.properties
}

// ---- Constants ------------------------------------------------------------

const TOP_K = 8;
const PRUNE_THRESHOLD = 0.1;

const BM25_K1 = 1.2;
const BM25_B  = 0.75;
const FIELD_WEIGHTS = { name: 6, description: 2, schemaKey: 1 } as const;

const CACHE_PATH = join(homedir(), ".pi", "agent", "mcp-cache.json");

// ---- Tokenizer ------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0);
}

// ---- BM25 -----------------------------------------------------------------

interface BM25Doc {
  entry: ToolEntry;
  termFreq: Map<string, number>;
  length: number;
}

interface BM25Index {
  docs: BM25Doc[];
  docFreq: Map<string, number>;
  avgLength: number;
}

function addWeightedTokens(tf: Map<string, number>, text: string, weight: number): void {
  for (const token of tokenize(text)) {
    tf.set(token, (tf.get(token) ?? 0) + weight);
  }
}

function buildDoc(entry: ToolEntry): BM25Doc {
  const tf = new Map<string, number>();
  addWeightedTokens(tf, entry.name, FIELD_WEIGHTS.name);
  addWeightedTokens(tf, entry.description, FIELD_WEIGHTS.description);
  for (const key of entry.schemaKeys) {
    addWeightedTokens(tf, key, FIELD_WEIGHTS.schemaKey);
  }
  const length = Array.from(tf.values()).reduce((s, v) => s + v, 0);
  return { entry, termFreq: tf, length };
}

function buildBM25Index(entries: ToolEntry[]): BM25Index {
  const docs = entries.map(buildDoc);
  const avgLength = docs.length > 0
    ? docs.reduce((s, d) => s + d.length, 0) / docs.length
    : 1;
  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.termFreq.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  return { docs, docFreq, avgLength };
}

function scoreBM25(index: BM25Index, query: string): Array<{ entry: ToolEntry; score: number }> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || index.docs.length === 0) return [];

  const N = index.docs.length;
  return index.docs
    .map(doc => {
      let score = 0;
      for (const token of queryTokens) {
        const tf = doc.termFreq.get(token) ?? 0;
        if (tf === 0) continue;
        const df = index.docFreq.get(token) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const norm = BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / index.avgLength));
        score += idf * (tf * (BM25_K1 + 1)) / (tf + norm);
      }
      return { entry: doc.entry, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
}
```

- [ ] **Step 2: Add smoke test and run it**

Append temporarily to the file:

```typescript
// SMOKE TEST — remove before shipping
(function selfTest() {
  const entries: ToolEntry[] = [
    { name: "sqlite_list_tables", server: "sqlite", description: "List all tables in the SQLite database", schemaKeys: [] },
    { name: "castai_prod_master_get_node_metrics", server: "castai_prod_master", description: "Get CPU and memory metrics for a cluster node", schemaKeys: ["cluster_id", "metric_type", "time_range"] },
    { name: "grafana_prod_master_query_loki_logs", server: "grafana_prod_master", description: "Query log streams using LogQL", schemaKeys: ["logql", "start", "end", "limit"] },
  ];
  const idx = buildBM25Index(entries);

  const r1 = scoreBM25(idx, "list tables database");
  console.assert(r1[0]?.entry.name === "sqlite_list_tables", "T1 failed: " + r1[0]?.entry.name);

  const r2 = scoreBM25(idx, "cluster cpu memory metrics");
  console.assert(r2[0]?.entry.name === "castai_prod_master_get_node_metrics", "T2 failed: " + r2[0]?.entry.name);

  const r3 = scoreBM25(idx, "logs loki logql");
  console.assert(r3[0]?.entry.name === "grafana_prod_master_query_loki_logs", "T3 failed: " + r3[0]?.entry.name);

  const r4 = scoreBM25(idx, "");
  console.assert(r4.length === 0, "T4 failed: empty query should return []");

  // Field weight test: name match should beat description-only match
  const entries2: ToolEntry[] = [
    { name: "list_tables", server: "s", description: "does something with databases", schemaKeys: [] },
    { name: "other_tool", server: "s", description: "list tables in database schema", schemaKeys: [] },
  ];
  const idx2 = buildBM25Index(entries2);
  const r5 = scoreBM25(idx2, "list tables");
  console.assert(r5[0]?.entry.name === "list_tables", "T5 failed: name match should rank higher than description match");

  console.log("[tool-selector] smoke tests passed");
})();
```

Run:
```bash
echo "hello" | pi -p --extension ~/.pi/agent/extensions/tool-selector.ts 2>&1 | grep "smoke\|assert\|failed\|Error"
```

Expected:
```
[tool-selector] smoke tests passed
```

- [ ] **Step 3: Remove smoke test, commit**

Delete the `(function selfTest() { ... })();` block.

```bash
cd ~/.pi/agent/extensions
git add tool-selector.ts
git commit -m "feat: BM25 with field weights (name×6, desc×2, schema×1)"
```

---

## Task 2: Cache Reader

**Files:**
- Modify: `~/.pi/agent/extensions/tool-selector.ts` (append cache reader before extension export)

- [ ] **Step 1: Append cache reader**

Append to the file (after `scoreBM25`, before the extension export):

```typescript
// ---- Cache Reader ---------------------------------------------------------

interface CachedToolDef {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, { description?: string; type?: string }>;
  };
}

interface McpCache {
  version: number;
  servers: Record<string, { tools?: CachedToolDef[] }>;
}

function loadToolEntries(): ToolEntry[] {
  if (!existsSync(CACHE_PATH)) {
    console.warn("[tool-selector] mcp-cache.json not found at", CACHE_PATH);
    return [];
  }
  try {
    const raw: McpCache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    if (raw.version !== 1 || !raw.servers) {
      console.warn("[tool-selector] unexpected cache format");
      return [];
    }
    const entries: ToolEntry[] = [];
    for (const [serverName, serverEntry] of Object.entries(raw.servers)) {
      if (!Array.isArray(serverEntry.tools)) continue;
      for (const tool of serverEntry.tools) {
        entries.push({
          name: `${serverName}_${tool.name}`,
          server: serverName,
          description: tool.description ?? "",
          schemaKeys: tool.inputSchema?.properties
            ? Object.keys(tool.inputSchema.properties)
            : [],
        });
      }
    }
    return entries;
  } catch (err) {
    console.error("[tool-selector] failed to read mcp-cache.json:", err);
    return [];
  }
}
```

- [ ] **Step 2: Smoke test cache reader**

```bash
node -e "
const { readFileSync, existsSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const CACHE_PATH = join(homedir(), '.pi', 'agent', 'mcp-cache.json');
const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
let count = 0;
for (const [srv, entry] of Object.entries(raw.servers)) {
  if (!Array.isArray(entry.tools)) continue;
  for (const t of entry.tools) {
    count++;
    const name = srv + '_' + t.name;
    const keys = t.inputSchema?.properties ? Object.keys(t.inputSchema.properties) : [];
    if (count <= 3) console.log(name, '| keys:', keys.join(', '));
  }
}
console.log('total:', count, 'tools');
"
```

Expected: prints 3 sample tool names with schema keys, then total count > 0.

- [ ] **Step 3: Commit**

```bash
cd ~/.pi/agent/extensions
git add tool-selector.ts
git commit -m "feat: cache reader producing ToolEntry[] with schemaKeys"
```

---

## Task 3: Extension with search_tool_bm25

**Files:**
- Modify: `~/.pi/agent/extensions/tool-selector.ts` (append extension export)

- [ ] **Step 1: Append the full extension export**

Append to the file:

```typescript
// ---- Extension ------------------------------------------------------------

export default function toolSelector(pi: ExtensionAPI) {
  let bm25Index: BM25Index | null = null;
  let builtins: string[] = [];
  const activeMcpTools = new Set<string>();

  function applyActiveTools(): void {
    try {
      pi.setActiveTools([...builtins, ...activeMcpTools]);
    } catch (err) {
      console.error("[tool-selector] setActiveTools failed:", err);
    }
  }

  pi.on("session_start", (_event) => {
    activeMcpTools.clear();
    const entries = loadToolEntries();
    if (entries.length === 0) {
      console.warn("[tool-selector] no tools loaded; falling back to mcp proxy");
      builtins = pi.getAllTools().map(t => t.name).filter(n => n !== "mcp");
      applyActiveTools();
      return;
    }

    const mcpNames = new Set(entries.map(e => e.name));
    // Builtins = everything registered that is not an MCP direct tool and not the mcp proxy
    builtins = pi.getAllTools().map(t => t.name).filter(n => !mcpNames.has(n) && n !== "mcp");

    bm25Index = buildBM25Index(entries);
    console.log(`[tool-selector] indexed ${entries.length} tools, ${builtins.length} builtins always active`);

    // Hide all MCP direct tools at session start
    applyActiveTools();
  });

  pi.registerTool({
    name: "search_tool_bm25",
    label: "Search MCP Tools",
    description: "Search for and activate relevant MCP tools by keyword. Call this before using any MCP capability. Active tools stay active until a new search re-scores them — tools scoring below threshold are deactivated.",
    promptSnippet: "Search for MCP tools: search_tool_bm25({ query: \"cluster metrics cpu\" })",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Keywords describing the capability you need" },
        limit: { type: "number", description: `Max tools to activate (default ${TOP_K})` },
      },
      required: ["query"],
    } as never,
    execute: async (_toolCallId, params: { query?: string; limit?: number }) => {
      const query = (params.query ?? "").trim();
      if (!query) {
        return {
          content: [{ type: "text" as const, text: "Error: query must not be empty" }],
        };
      }
      if (!bm25Index) {
        return {
          content: [{ type: "text" as const, text: "Tool index not ready. Try again after session_start completes." }],
        };
      }

      const limit = params.limit ?? TOP_K;
      const ranked = scoreBM25(bm25Index, query);

      // Prune: drop active MCP tools that score below threshold
      const pruned: string[] = [];
      const scoreByName = new Map(ranked.map(r => [r.entry.name, r.score]));
      for (const name of [...activeMcpTools]) {
        const score = scoreByName.get(name) ?? 0;
        if (score < PRUNE_THRESHOLD) {
          activeMcpTools.delete(name);
          pruned.push(name);
        }
      }

      // Activate: top-K results not already active
      const activated: string[] = [];
      for (const { entry } of ranked) {
        if (activated.length >= limit) break;
        if (activeMcpTools.has(entry.name)) continue;
        activeMcpTools.add(entry.name);
        activated.push(entry.name);
      }

      applyActiveTools();

      const lines: string[] = [];
      if (activated.length > 0) lines.push(`Activated (${activated.length}): ${activated.join(", ")}`);
      if (pruned.length > 0) lines.push(`Pruned (${pruned.length}): ${pruned.join(", ")}`);
      lines.push(`Active MCP tools: ${activeMcpTools.size > 0 ? [...activeMcpTools].join(", ") : "(none)"}`);
      lines.push(`Total indexed: ${bm25Index.docs.length}`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  });
}
```

- [ ] **Step 2: Verify the extension loads and hides MCP tools**

```bash
echo "hello" | pi -p --extension ~/.pi/agent/extensions/tool-selector.ts 2>&1 | grep "tool-selector"
```

Expected:
```
[tool-selector] indexed N tools, M builtins always active
```

N > 0, no errors.

- [ ] **Step 3: Verify search_tool_bm25 is registered**

```bash
cat > /tmp/check-tools.ts << 'EOF'
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function check(pi: ExtensionAPI) {
  pi.on("session_start", () => {
    const names = pi.getAllTools().map(t => t.name);
    console.log("[check]", names.join(", "));
  });
}
EOF
echo "hello" | pi -p \
  --extension ~/.pi/agent/extensions/tool-selector.ts \
  --extension /tmp/check-tools.ts 2>&1 | grep "check\]"
```

Expected: `search_tool_bm25` appears in the list.

- [ ] **Step 4: Commit**

```bash
cd ~/.pi/agent/extensions
git add tool-selector.ts
git commit -m "feat: search_tool_bm25 with additive activation and prune-on-search"
```

---

## Task 4: Integration Test

**Files:**
- No code changes — test only.

- [ ] **Step 1: Start a Pi session and run a search**

```bash
pi --extension ~/.pi/agent/extensions/tool-selector.ts
```

Ask: `search for tools that can list database tables`

Expected behavior: model calls `search_tool_bm25({ query: "list database tables" })`, response shows activated sqlite tools, model then calls `sqlite_list_tables` directly without going through `mcp`.

- [ ] **Step 2: Verify pruning**

In the same session ask: `search for tools related to kubernetes cluster metrics`

Expected: response shows castai metrics tools activated, sqlite tools pruned (they score ~0 against a kubernetes query).

- [ ] **Step 3: Verify builtins always present**

In same session ask: `read the file /tmp/test.db`

Expected: model uses `read` directly — builtin tools unaffected by any search.

- [ ] **Step 4: Final file structure check**

```bash
cat ~/.pi/agent/extensions/tool-selector.ts
```

Checklist:
- [ ] `tokenize` with camelCase split
- [ ] `buildBM25Index` using weighted TF
- [ ] `scoreBM25` returning `{entry, score}[]`
- [ ] `loadToolEntries` returning `ToolEntry[]` with `schemaKeys`
- [ ] `export default function toolSelector` with `session_start` handler hiding MCP tools
- [ ] `pi.registerTool("search_tool_bm25", ...)` with prune + activate logic
- [ ] No smoke test code, no debug logs

---

## Complete Final File

`~/.pi/agent/extensions/tool-selector.ts` (assembled from all tasks):

```typescript
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---- Types ----------------------------------------------------------------

interface ToolEntry {
  name: string;
  server: string;
  description: string;
  schemaKeys: string[];
}

// ---- Constants ------------------------------------------------------------

const TOP_K = 8;
const PRUNE_THRESHOLD = 0.1;

const BM25_K1 = 1.2;
const BM25_B  = 0.75;
const FIELD_WEIGHTS = { name: 6, description: 2, schemaKey: 1 } as const;

const CACHE_PATH = join(homedir(), ".pi", "agent", "mcp-cache.json");

// ---- Tokenizer ------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0);
}

// ---- BM25 -----------------------------------------------------------------

interface BM25Doc {
  entry: ToolEntry;
  termFreq: Map<string, number>;
  length: number;
}

interface BM25Index {
  docs: BM25Doc[];
  docFreq: Map<string, number>;
  avgLength: number;
}

function addWeightedTokens(tf: Map<string, number>, text: string, weight: number): void {
  for (const token of tokenize(text)) {
    tf.set(token, (tf.get(token) ?? 0) + weight);
  }
}

function buildDoc(entry: ToolEntry): BM25Doc {
  const tf = new Map<string, number>();
  addWeightedTokens(tf, entry.name, FIELD_WEIGHTS.name);
  addWeightedTokens(tf, entry.description, FIELD_WEIGHTS.description);
  for (const key of entry.schemaKeys) {
    addWeightedTokens(tf, key, FIELD_WEIGHTS.schemaKey);
  }
  const length = Array.from(tf.values()).reduce((s, v) => s + v, 0);
  return { entry, termFreq: tf, length };
}

function buildBM25Index(entries: ToolEntry[]): BM25Index {
  const docs = entries.map(buildDoc);
  const avgLength = docs.length > 0
    ? docs.reduce((s, d) => s + d.length, 0) / docs.length
    : 1;
  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.termFreq.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  return { docs, docFreq, avgLength };
}

function scoreBM25(index: BM25Index, query: string): Array<{ entry: ToolEntry; score: number }> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || index.docs.length === 0) return [];

  const N = index.docs.length;
  return index.docs
    .map(doc => {
      let score = 0;
      for (const token of queryTokens) {
        const tf = doc.termFreq.get(token) ?? 0;
        if (tf === 0) continue;
        const df = index.docFreq.get(token) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const norm = BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / index.avgLength));
        score += idf * (tf * (BM25_K1 + 1)) / (tf + norm);
      }
      return { entry: doc.entry, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
}

// ---- Cache Reader ---------------------------------------------------------

interface CachedToolDef {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, { description?: string; type?: string }>;
  };
}

interface McpCache {
  version: number;
  servers: Record<string, { tools?: CachedToolDef[] }>;
}

function loadToolEntries(): ToolEntry[] {
  if (!existsSync(CACHE_PATH)) {
    console.warn("[tool-selector] mcp-cache.json not found at", CACHE_PATH);
    return [];
  }
  try {
    const raw: McpCache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    if (raw.version !== 1 || !raw.servers) {
      console.warn("[tool-selector] unexpected cache format");
      return [];
    }
    const entries: ToolEntry[] = [];
    for (const [serverName, serverEntry] of Object.entries(raw.servers)) {
      if (!Array.isArray(serverEntry.tools)) continue;
      for (const tool of serverEntry.tools) {
        entries.push({
          name: `${serverName}_${tool.name}`,
          server: serverName,
          description: tool.description ?? "",
          schemaKeys: tool.inputSchema?.properties
            ? Object.keys(tool.inputSchema.properties)
            : [],
        });
      }
    }
    return entries;
  } catch (err) {
    console.error("[tool-selector] failed to read mcp-cache.json:", err);
    return [];
  }
}

// ---- Extension ------------------------------------------------------------

export default function toolSelector(pi: ExtensionAPI) {
  let bm25Index: BM25Index | null = null;
  let builtins: string[] = [];
  const activeMcpTools = new Set<string>();

  function applyActiveTools(): void {
    try {
      pi.setActiveTools([...builtins, ...activeMcpTools]);
    } catch (err) {
      console.error("[tool-selector] setActiveTools failed:", err);
    }
  }

  pi.on("session_start", (_event) => {
    activeMcpTools.clear();
    const entries = loadToolEntries();
    if (entries.length === 0) {
      console.warn("[tool-selector] no tools loaded; falling back to mcp proxy");
      builtins = pi.getAllTools().map(t => t.name).filter(n => n !== "mcp");
      applyActiveTools();
      return;
    }

    const mcpNames = new Set(entries.map(e => e.name));
    builtins = pi.getAllTools().map(t => t.name).filter(n => !mcpNames.has(n) && n !== "mcp");

    bm25Index = buildBM25Index(entries);
    console.log(`[tool-selector] indexed ${entries.length} tools, ${builtins.length} builtins always active`);

    applyActiveTools();
  });

  pi.registerTool({
    name: "search_tool_bm25",
    label: "Search MCP Tools",
    description: "Search for and activate relevant MCP tools by keyword. Call this before using any MCP capability. Active tools stay active until a new search re-scores them — tools scoring below threshold are deactivated.",
    promptSnippet: "Search for MCP tools: search_tool_bm25({ query: \"cluster metrics cpu\" })",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Keywords describing the capability you need" },
        limit: { type: "number", description: `Max tools to activate (default ${TOP_K})` },
      },
      required: ["query"],
    } as never,
    execute: async (_toolCallId, params: { query?: string; limit?: number }) => {
      const query = (params.query ?? "").trim();
      if (!query) {
        return {
          content: [{ type: "text" as const, text: "Error: query must not be empty" }],
        };
      }
      if (!bm25Index) {
        return {
          content: [{ type: "text" as const, text: "Tool index not ready. Try again after session_start completes." }],
        };
      }

      const limit = params.limit ?? TOP_K;
      const ranked = scoreBM25(bm25Index, query);

      const pruned: string[] = [];
      const scoreByName = new Map(ranked.map(r => [r.entry.name, r.score]));
      for (const name of [...activeMcpTools]) {
        const score = scoreByName.get(name) ?? 0;
        if (score < PRUNE_THRESHOLD) {
          activeMcpTools.delete(name);
          pruned.push(name);
        }
      }

      const activated: string[] = [];
      for (const { entry } of ranked) {
        if (activated.length >= limit) break;
        if (activeMcpTools.has(entry.name)) continue;
        activeMcpTools.add(entry.name);
        activated.push(entry.name);
      }

      applyActiveTools();

      const lines: string[] = [];
      if (activated.length > 0) lines.push(`Activated (${activated.length}): ${activated.join(", ")}`);
      if (pruned.length > 0) lines.push(`Pruned (${pruned.length}): ${pruned.join(", ")}`);
      lines.push(`Active MCP tools: ${activeMcpTools.size > 0 ? [...activeMcpTools].join(", ") : "(none)"}`);
      lines.push(`Total indexed: ${bm25Index.docs.length}`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  });
}
```
