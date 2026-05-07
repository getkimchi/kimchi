# MCP Tool Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Pi extension that runs BM25 scoring over the MCP tool catalog before each model call and injects the top-K most relevant tools via `setActiveTools`, reducing context bloat from 176 tools to ~5 per turn.

**Architecture:** Single TypeScript file loaded by Pi at runtime (`~/.pi/agent/extensions/tool-selector.ts`). On `session_start`, reads the tool catalog from `~/.pi/agent/mcp-cache.json` (written by pi-mcp-adapter) and builds an in-memory BM25 index. On each `input` event, scores a rolling window of recent messages against the index and calls `setActiveTools`. The `mcp` proxy is always included as a fallback.

**Tech Stack:** TypeScript (no build step, no npm deps), Pi `ExtensionAPI` (`@mariozechner/pi-coding-agent`), BM25 with suffix stemming and stop-word filtering, Node.js `fs` module for cache read.

---

## File Map

| Action | Path |
|---|---|
| Create | `~/.pi/agent/extensions/tool-selector.ts` |

No changes to pi-mcp-adapter.

---

## Cache Format Reference

`~/.pi/agent/mcp-cache.json` (written by pi-mcp-adapter, version 1):

```json
{
  "version": 1,
  "servers": {
    "castai_prod_master": {
      "configHash": "...",
      "cachedAt": 1234567890,
      "tools": [
        {
          "name": "get_node_metrics",
          "description": "Returns node-level metrics...",
          "inputSchema": {
            "type": "object",
            "properties": {
              "cluster_id": { "type": "string", "description": "Cluster ID" },
              "metric_type": { "type": "string", "description": "cpu or memory" }
            }
          }
        }
      ],
      "resources": []
    }
  }
}
```

The registered tool name Pi/LLM uses is `"{serverName}__{toolName}"` (double underscore), e.g. `"castai_prod_master__get_node_metrics"`. The `mcp` proxy tool is always registered separately.

---

### Task 1: BM25 Scorer

**Files:**
- Create: `~/.pi/agent/extensions/tool-selector.ts`

BM25 parameters: k1=1.5, b=0.75. Stop words listed below. Stemming: strip trailing `-ing`, `-ed`, `-s` (in that order, only if resulting stem ≥ 3 chars).

- [ ] **Step 1: Create the file with types, constants, and tokenizer**

Create `~/.pi/agent/extensions/tool-selector.ts`:

```typescript
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---- Types ----------------------------------------------------------------

interface ToolEntry {
  name: string;       // registered name, e.g. "castai_prod_master__get_node_metrics"
  server: string;     // server name, e.g. "castai_prod_master"
  indexText: string;  // name + description + schema param names/descriptions
}

type SelectionStrategy = (query: string) => ToolEntry[];

// ---- Constants ------------------------------------------------------------

const TOP_K = 5;
const WINDOW_SIZE = 3; // user turns kept; same number of assistant turns also kept

const STOP_WORDS = new Set([
  "a","an","the","to","of","in","for","with","and","or","is","are","be",
  "that","this","it","from","by","as","on","at","returns","return","used",
  "use","can","will","all","any","each","when","which","how",
]);

const BM25_K1 = 1.5;
const BM25_B  = 0.75;

const CACHE_PATH = join(homedir(), ".pi", "agent", "mcp-cache.json");

// ---- Tokenizer ------------------------------------------------------------

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed"))  return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s"))   return word.slice(0, -1);
  return word;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")  // split on underscores too so get_node_metrics → ["get","node","metrics"]
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t))
    .map(stem);
}
```

- [ ] **Step 2: Add BM25 index builder and scorer**

Append to the file:

```typescript
// ---- BM25 -----------------------------------------------------------------

interface BM25Index {
  entries: ToolEntry[];
  tf: Map<string, number>[];     // per-document term frequency
  idf: Map<string, number>;      // corpus-wide inverse document frequency
  docLengths: number[];
  avgDocLength: number;
}

function buildBM25Index(entries: ToolEntry[]): BM25Index {
  const tf: Map<string, number>[] = [];
  const df = new Map<string, number>();
  const docLengths: number[] = [];

  for (const entry of entries) {
    const tokens = tokenize(entry.indexText);
    docLengths.push(tokens.length);
    const docTf = new Map<string, number>();
    for (const t of tokens) {
      docTf.set(t, (docTf.get(t) ?? 0) + 1);
    }
    tf.push(docTf);
    for (const t of docTf.keys()) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  const N = entries.length;
  const avgDocLength = N > 0
    ? docLengths.reduce((a, b) => a + b, 0) / N
    : 1;
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
  }

  return { entries, tf, idf, docLengths, avgDocLength };
}

function scoreBM25(index: BM25Index, query: string): ToolEntry[] {
  if (index.entries.length === 0) return [];
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scores: number[] = new Array(index.entries.length).fill(0);

  for (const term of queryTokens) {
    const idfScore = index.idf.get(term) ?? 0;
    if (idfScore === 0) continue;
    for (let i = 0; i < index.entries.length; i++) {
      const freq = index.tf[i].get(term) ?? 0;
      if (freq === 0) continue;
      const dl = index.docLengths[i];
      const norm = 1 - BM25_B + BM25_B * (dl / index.avgDocLength);
      scores[i] += idfScore * ((freq * (BM25_K1 + 1)) / (freq + BM25_K1 * norm));
    }
  }

  return index.entries
    .map((entry, i) => ({ entry, score: scores[i] }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.entry);
}
```

- [ ] **Step 3: Write a quick smoke test and run it**

Append temporarily at the bottom of the file (outside any export):

```typescript
// SMOKE TEST — remove before shipping
(function selfTest() {
  const entries: ToolEntry[] = [
    { name: "castai_prod_master__get_node_metrics", server: "castai_prod_master",
      indexText: "castai_prod_master__get_node_metrics get node metrics cluster_id metric_type time_range CPU memory usage performance" },
    { name: "castai_prod_master__list_clusters", server: "castai_prod_master",
      indexText: "castai_prod_master__list_clusters list cluster all cluster available organization" },
    { name: "grafana_prod_master__query_loki_logs", server: "grafana_prod_master",
      indexText: "grafana_prod_master__query_loki_logs search log loki logql filter namespace pod label stream" },
  ];
  const idx = buildBM25Index(entries);

  const r1 = scoreBM25(idx, "cluster cpu performance");
  console.assert(r1[0]?.name === "castai_prod_master__get_node_metrics",
    "Test 1 failed: expected get_node_metrics first, got: " + r1[0]?.name);

  const r2 = scoreBM25(idx, "loki logs namespace");
  console.assert(r2[0]?.name === "grafana_prod_master__query_loki_logs",
    "Test 2 failed: expected query_loki_logs first, got: " + r2[0]?.name);

  const r3 = scoreBM25(idx, "");
  console.assert(r3.length === 0, "Test 3 failed: empty query should return []");

  console.log("[tool-selector] smoke test passed");
})();
```

Run:

```bash
echo "hello" | pi -p --extension ~/.pi/agent/extensions/tool-selector.ts 2>&1 | grep "smoke test\|assert\|Error\|failed"
```

Expected:
```
[tool-selector] smoke test passed
```

- [ ] **Step 4: Remove the smoke test block**

Delete the `(function selfTest() { ... })();` block from the bottom of the file.

---

### Task 2: Tool Catalog Loading (session_start)

**Files:**
- Modify: `~/.pi/agent/extensions/tool-selector.ts` (add cache reader and session_start handler)

- [ ] **Step 1: Add cache loader**

Append to the file, before the extension export:

```typescript
// ---- Cache Reader ---------------------------------------------------------

interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { description?: string; type?: string }>;
  };
}

interface ServerCacheEntry {
  tools: CachedTool[];
  resources?: unknown[];
}

interface McpCache {
  version: number;
  servers: Record<string, ServerCacheEntry>;
}

function flattenSchema(
  props: Record<string, { description?: string; type?: string }> | undefined
): string {
  if (!props) return "";
  return Object.entries(props)
    .map(([name, def]) => name + (def.description ? " " + def.description : ""))
    .join(" ");
}

function loadToolEntries(): ToolEntry[] {
  if (!existsSync(CACHE_PATH)) {
    console.warn("[tool-selector] mcp-cache.json not found at", CACHE_PATH);
    return [];
  }
  try {
    const raw: McpCache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    if (raw.version !== 1 || !raw.servers) {
      console.warn("[tool-selector] unexpected cache version:", raw.version);
      return [];
    }
    const entries: ToolEntry[] = [];
    for (const [serverName, serverEntry] of Object.entries(raw.servers)) {
      for (const tool of serverEntry.tools) {
        const registeredName = `${serverName}__${tool.name}`;
        const indexText = [
          registeredName,
          tool.description ?? "",
          flattenSchema(tool.inputSchema?.properties),
        ]
          .join(" ")
          .trim();
        entries.push({ name: registeredName, server: serverName, indexText });
      }
    }
    return entries;
  } catch (err) {
    console.error("[tool-selector] failed to read mcp-cache.json:", err);
    return [];
  }
}
```

- [ ] **Step 2: Add the complete extension export (session_start + input + message_end)**

Append to the file. This is the complete extension function — all three handlers included here so there is no open-brace ambiguity across tasks:

```typescript
// ---- Extension ------------------------------------------------------------

export default function toolSelector(pi: ExtensionAPI) {
  let bm25Index: BM25Index | null = null;

  const strategy: SelectionStrategy = (query) => {
    if (!bm25Index) return [];
    return scoreBM25(bm25Index, query).slice(0, TOP_K);
  };

  const window: string[] = [];

  function appendToWindow(text: string) {
    window.push(text);
    const maxEntries = WINDOW_SIZE * 2;
    while (window.length > maxEntries) {
      window.shift();
    }
  }

  pi.on("session_start", (_event) => {
    const rawEntries = loadToolEntries();
    if (rawEntries.length === 0) {
      console.warn("[tool-selector] no tools loaded; selector disabled");
      return;
    }
    // Cross-reference against actually registered tools to guard against
    // toolPrefix config changes or stale cache entries
    const registeredNames = new Set(pi.getAllTools().map(t => t.name));
    const entries = rawEntries.filter(e => registeredNames.has(e.name));
    if (entries.length === 0) {
      console.warn("[tool-selector] no cache entries match registered tools; check toolPrefix config");
      return;
    }
    bm25Index = buildBM25Index(entries);
    console.log(`[tool-selector] indexed ${entries.length} tools`);
  });

  pi.on("input", (event) => {
    appendToWindow(event.text);

    if (!bm25Index) {
      pi.setActiveTools(["mcp"]);
      return;
    }

    const query = window.join(" ");
    const selected = strategy(query);
    const toolNames = selected.map(t => t.name);

    try {
      pi.setActiveTools([...toolNames, "mcp"]);
    } catch (err) {
      console.error("[tool-selector] setActiveTools failed:", err);
    }
  });

  pi.on("message_end", (event) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;

    const text = (msg.content as Array<{ type: string; text?: string }>)
      .filter(c => c.type === "text" && typeof c.text === "string")
      .map(c => c.text as string)
      .join(" ")
      .trim();

    if (text) appendToWindow(text);
  });
}
```

- [ ] **Step 3: Test catalog loading**

```bash
echo "hello" | pi -p --extension ~/.pi/agent/extensions/tool-selector.ts 2>&1 | grep "tool-selector"
```

Expected:
```
[tool-selector] indexed 235 tools
```

(Number varies based on what's in the cache. Must be > 0.)

---

### Task 3: Verify Selection and Rolling Window

**Files:**
- Modify: `~/.pi/agent/extensions/tool-selector.ts` (add temporary debug log, verify, remove)

- [ ] **Step 1: Add temporary selection log**

Inside the `input` handler, after `pi.setActiveTools(...)`, temporarily add:

```typescript
      console.log("[tool-selector] selected:", [...toolNames, "mcp"].join(", "));
```

- [ ] **Step 2: Run and verify**

```bash
echo "show me CPU usage for prod-master cluster" | pi -p \
  --extension ~/.pi/agent/extensions/tool-selector.ts 2>&1 | grep "tool-selector"
```

Expected:
```
[tool-selector] indexed N tools
[tool-selector] selected: castai_prod_master__get_node_metrics, castai_prod_eu__get_node_metrics, ..., mcp
```

Must see: (a) indexed N > 0, (b) selected tools include at least one metric-related tool, (c) `mcp` always last.

- [ ] **Step 3: Remove the debug log**

Delete the `console.log("[tool-selector] selected:...")` line.

---

### Task 4: Integration Test and Commit

**Files:**
- Modify: `~/.pi/agent/extensions/tool-selector.ts` (remove any debug logs, finalize)

- [ ] **Step 1: Verify the full file structure**

```bash
cat ~/.pi/agent/extensions/tool-selector.ts
```

Checklist:
- [ ] No smoke test code
- [ ] No `console.log("[tool-selector] selected:...")` debug line
- [ ] `export default function toolSelector(pi: ExtensionAPI)`
- [ ] `session_start`, `input`, `message_end` handlers present
- [ ] `loadToolEntries`, `flattenSchema`, `buildBM25Index`, `scoreBM25`, `tokenize`, `stem` at module level
- [ ] `TOP_K`, `WINDOW_SIZE`, `BM25_K1`, `BM25_B`, `STOP_WORDS`, `CACHE_PATH` constants at module level
- [ ] `appendToWindow` defined inside export function (closes over `window`)

- [ ] **Step 2: Run end-to-end integration test**

```bash
echo "show me CPU usage for prod-master cluster" | pi -p \
  --extension ~/.pi/agent/extensions/tool-selector.ts 2>&1 | tee /tmp/selector-test.log

grep "tool-selector\|Error\|error" /tmp/selector-test.log
```

Expected:
- `[tool-selector] indexed N tools` (N > 0)
- No `[tool-selector] failed` or `error` lines
- Model response mentions cluster metrics or asks for cluster ID

- [ ] **Step 3: Run a second turn test (rolling window)**

```bash
cat << 'EOF' | pi -p --extension ~/.pi/agent/extensions/tool-selector.ts 2>&1 | grep "tool-selector"
show me logs for pod crashing in prod
EOF
```

Expect grafana/loki tools to appear in active set.

- [ ] **Step 4: Commit**

If `~/.pi/agent/extensions/` is tracked in a separate git repo:

```bash
cd ~/.pi/agent/extensions
git add tool-selector.ts
git commit -m "feat: BM25 per-turn tool selector extension

Intercepts input events, reads mcp-cache.json, scores tool catalog with
BM25 and injects top-5 relevant tools via setActiveTools before each
model call. mcp proxy always included as fallback.

Refs: LLM-1249"
```

If not in a git repo, the file is already in place and no commit is needed.

---

## Complete Final File

`~/.pi/agent/extensions/tool-selector.ts`:

```typescript
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---- Types ----------------------------------------------------------------

interface ToolEntry {
  name: string;
  server: string;
  indexText: string;
}

type SelectionStrategy = (query: string) => ToolEntry[];

// ---- Constants ------------------------------------------------------------

const TOP_K = 5;
const WINDOW_SIZE = 3;

const STOP_WORDS = new Set([
  "a","an","the","to","of","in","for","with","and","or","is","are","be",
  "that","this","it","from","by","as","on","at","returns","return","used",
  "use","can","will","all","any","each","when","which","how",
]);

const BM25_K1 = 1.5;
const BM25_B  = 0.75;

const CACHE_PATH = join(homedir(), ".pi", "agent", "mcp-cache.json");

// ---- Tokenizer ------------------------------------------------------------

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed"))  return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s"))   return word.slice(0, -1);
  return word;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")  // split on underscores: get_node_metrics → ["get","node","metrics"]
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t))
    .map(stem);
}

// ---- BM25 -----------------------------------------------------------------

interface BM25Index {
  entries: ToolEntry[];
  tf: Map<string, number>[];
  idf: Map<string, number>;
  docLengths: number[];
  avgDocLength: number;
}

function buildBM25Index(entries: ToolEntry[]): BM25Index {
  const tf: Map<string, number>[] = [];
  const df = new Map<string, number>();
  const docLengths: number[] = [];

  for (const entry of entries) {
    const tokens = tokenize(entry.indexText);
    docLengths.push(tokens.length);
    const docTf = new Map<string, number>();
    for (const t of tokens) {
      docTf.set(t, (docTf.get(t) ?? 0) + 1);
    }
    tf.push(docTf);
    for (const t of docTf.keys()) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  const N = entries.length;
  const avgDocLength = N > 0
    ? docLengths.reduce((a, b) => a + b, 0) / N
    : 1;
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
  }

  return { entries, tf, idf, docLengths, avgDocLength };
}

function scoreBM25(index: BM25Index, query: string): ToolEntry[] {
  if (index.entries.length === 0) return [];
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scores: number[] = new Array(index.entries.length).fill(0);

  for (const term of queryTokens) {
    const idfScore = index.idf.get(term) ?? 0;
    if (idfScore === 0) continue;
    for (let i = 0; i < index.entries.length; i++) {
      const freq = index.tf[i].get(term) ?? 0;
      if (freq === 0) continue;
      const dl = index.docLengths[i];
      const norm = 1 - BM25_B + BM25_B * (dl / index.avgDocLength);
      scores[i] += idfScore * ((freq * (BM25_K1 + 1)) / (freq + BM25_K1 * norm));
    }
  }

  return index.entries
    .map((entry, i) => ({ entry, score: scores[i] }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.entry);
}

// ---- Cache Reader ---------------------------------------------------------

interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { description?: string; type?: string }>;
  };
}

interface McpCache {
  version: number;
  servers: Record<string, { tools: CachedTool[]; resources?: unknown[] }>;
}

function flattenSchema(
  props: Record<string, { description?: string; type?: string }> | undefined
): string {
  if (!props) return "";
  return Object.entries(props)
    .map(([name, def]) => name + (def.description ? " " + def.description : ""))
    .join(" ");
}

function loadToolEntries(): ToolEntry[] {
  if (!existsSync(CACHE_PATH)) {
    console.warn("[tool-selector] mcp-cache.json not found at", CACHE_PATH);
    return [];
  }
  try {
    const raw: McpCache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    if (raw.version !== 1 || !raw.servers) {
      console.warn("[tool-selector] unexpected cache version:", raw.version);
      return [];
    }
    const entries: ToolEntry[] = [];
    for (const [serverName, serverEntry] of Object.entries(raw.servers)) {
      for (const tool of serverEntry.tools) {
        const registeredName = `${serverName}__${tool.name}`;
        const indexText = [
          registeredName,
          tool.description ?? "",
          flattenSchema(tool.inputSchema?.properties),
        ]
          .join(" ")
          .trim();
        entries.push({ name: registeredName, server: serverName, indexText });
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

  const strategy: SelectionStrategy = (query) => {
    if (!bm25Index) return [];
    return scoreBM25(bm25Index, query).slice(0, TOP_K);
  };

  const window: string[] = [];

  function appendToWindow(text: string) {
    window.push(text);
    const maxEntries = WINDOW_SIZE * 2;
    while (window.length > maxEntries) {
      window.shift();
    }
  }

  pi.on("session_start", (_event) => {
    const rawEntries = loadToolEntries();
    if (rawEntries.length === 0) {
      console.warn("[tool-selector] no tools loaded; selector disabled");
      return;
    }
    // Cross-reference against actually registered tools to guard against
    // toolPrefix config changes or stale cache entries
    const registeredNames = new Set(pi.getAllTools().map(t => t.name));
    const entries = rawEntries.filter(e => registeredNames.has(e.name));
    if (entries.length === 0) {
      console.warn("[tool-selector] no cache entries match registered tools; check toolPrefix config");
      return;
    }
    bm25Index = buildBM25Index(entries);
    console.log(`[tool-selector] indexed ${entries.length} tools`);
  });

  pi.on("input", (event) => {
    appendToWindow(event.text);

    if (!bm25Index) {
      pi.setActiveTools(["mcp"]);
      return;
    }

    const query = window.join(" ");
    const selected = strategy(query);
    const toolNames = selected.map(t => t.name);

    try {
      pi.setActiveTools([...toolNames, "mcp"]);
    } catch (err) {
      console.error("[tool-selector] setActiveTools failed:", err);
    }
  });

  pi.on("message_end", (event) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;

    const text = (msg.content as Array<{ type: string; text?: string }>)
      .filter(c => c.type === "text" && typeof c.text === "string")
      .map(c => c.text as string)
      .join(" ")
      .trim();

    if (text) appendToWindow(text);
  });
}
```
