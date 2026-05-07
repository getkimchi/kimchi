# Tool Selector v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `tool-selector.ts` to support swappable search strategies (BM25 and regex built-in), add `pinnedTools` config, reduce default topK to 5, and inject a system prompt hint listing available MCP servers.

**Architecture:** Single file `~/sandbox/pi/extensions/tool-selector.ts`. A `SearchStrategy` interface decouples scoring from the extension loop. `session_start` builds the active strategy from config and pins specified tools. `before_agent_start` appends a one-line server list to the system prompt each turn. BM25 and regex are two concrete strategies; adding more later is just implementing the interface.

**Tech Stack:** TypeScript, Node.js `fs`, Pi `ExtensionAPI` (`@mariozechner/pi-coding-agent`), no npm deps.

---

## Background

### Repo layout
```
~/sandbox/pi/extensions/
  tool-selector.ts   ← the only file we touch
  package.json       ← { "main": "tool-selector.ts" }
```

Pi loads this as an installed package (`pi install ~/sandbox/pi/extensions`). The file is also symlinked/copied into `~/.pi/agent/extensions/` — **do not write a copy there**, it will conflict. The installed package is the source of truth.

### Pi ExtensionAPI surface used
- `pi.on("session_start", handler)` — fires once per session; no return value
- `pi.on("before_agent_start", handler)` — fires before each agent loop turn; return `{ systemPrompt?: string }` to append to system prompt (multiple extensions chain)
- `pi.on("message_end", handler)` — fires after each assistant message
- `pi.getAllTools()` — returns all registered tools at the time of call
- `pi.setActiveTools(names: string[])` — restricts LLM-visible tools to exactly `names`; unknown names silently ignored
- `pi.registerTool(def)` — registers a new LLM-callable tool

### Config file: `~/.pi/agent/tool-selector.json`
Loaded at `session_start`. Missing file → use defaults. Missing fields → use per-field defaults.

### Cache file: `~/.pi/agent/mcp-cache.json`
Written by pi-mcp-adapter. Format:
```json
{ "version": 1, "servers": { "sqlite": { "tools": [{ "name": "list_tables", "description": "...", "inputSchema": { "properties": {} } }] } } }
```
Registered tool name = `{serverName}_{toolName}` (single underscore).

### Testing
No test runner is set up. Tests are inline self-executing functions appended temporarily to the file, run via:
```bash
echo "hello" | pi -p 2>&1 | grep -E "\[tool-selector\]"
```
Remove the test block before committing.

---

## File Structure

One file, sections in order:

```
// ---- Types
// ---- Config
// ---- Tokenizer
// ---- BM25 strategy
// ---- Regex strategy
// ---- Strategy factory
// ---- Cache reader
// ---- Extension
```

---

## Key Types

```typescript
interface ToolEntry {
  name: string;        // "sqlite_list_tables"
  server: string;      // "sqlite"
  description: string;
  schemaKeys: string[];
}

interface SearchResult {
  entry: ToolEntry;
  score: number;
}

interface SearchStrategy {
  search(query: string, limit: number): SearchResult[];
  // For pruning: score a single entry against current query.
  // Returns 0 if not scoreable (e.g. regex strategy with no last query).
  scoreOne(entry: ToolEntry, query: string): number;
}

interface Config {
  strategy: "bm25" | "regex";
  topK: number;
  pruneThreshold: number;
  pinnedTools: string[];
  // BM25-specific (ignored for regex strategy)
  bm25K1: number;
  bm25B: number;
  fieldWeights: { name: number; description: number; schemaKey: number };
}
```

---

## Config Defaults

```typescript
const DEFAULTS: Config = {
  strategy: "bm25",
  topK: 5,
  pruneThreshold: 0.1,
  pinnedTools: [],
  bm25K1: 1.2,
  bm25B: 0.75,
  fieldWeights: { name: 6, description: 2, schemaKey: 1 },
};
```

---

## Strategy Interfaces & Implementations

### BM25Strategy

Wraps the existing `BM25Index`. Implements `search` and `scoreOne`.

```typescript
class BM25Strategy implements SearchStrategy {
  constructor(private index: BM25Index, private k1: number, private b: number) {}

  search(query: string, limit: number): SearchResult[] {
    return scoreBM25(this.index, query, this.k1, this.b).slice(0, limit);
  }

  scoreOne(entry: ToolEntry, query: string): number {
    const results = scoreBM25(this.index, query, this.k1, this.b);
    return results.find(r => r.entry.name === entry.name)?.score ?? 0;
  }
}
```

### RegexStrategy

Scores by counting regex matches against `name` and `description`. No pre-processing needed.

```typescript
class RegexStrategy implements SearchStrategy {
  constructor(private entries: ToolEntry[]) {}

  search(query: string, limit: number): SearchResult[] {
    return this.scoreAll(query).slice(0, limit);
  }

  scoreOne(entry: ToolEntry, query: string): number {
    return this.scoreEntry(entry, query);
  }

  private scoreAll(query: string): SearchResult[] {
    let re: RegExp;
    try { re = new RegExp(query, "i"); } catch { return []; }
    return this.entries
      .map(entry => ({ entry, score: this.scoreEntry(entry, query, re) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  }

  private scoreEntry(entry: ToolEntry, _query: string, re?: RegExp): number {
    if (!re) {
      try { re = new RegExp(_query, "i"); } catch { return 0; }
    }
    let score = 0;
    if (re.test(entry.name)) score += 2;
    if (re.test(entry.description)) score += 1;
    for (const key of entry.schemaKeys) {
      if (re.test(key)) score += 0.5;
    }
    return score;
  }
}
```

### Strategy factory

```typescript
function buildStrategy(entries: ToolEntry[], cfg: Config): SearchStrategy {
  if (cfg.strategy === "regex") return new RegexStrategy(entries);
  const index = buildBM25Index(entries, cfg.fieldWeights);
  return new BM25Strategy(index, cfg.bm25K1, cfg.bm25B);
}
```

---

## System Prompt Injection

On `before_agent_start`, return:

```typescript
{
  systemPrompt: event.systemPrompt +
    `\n\nMCP servers available (use search_tool_bm25 to activate tools): ${serverNames.join(", ")}.`
}
```

`serverNames` is derived from the cache at `session_start` and stored in the closure.

---

## Task 1: SearchStrategy interface + BM25Strategy class

**Files:**
- Modify: `~/sandbox/pi/extensions/tool-selector.ts`

Replace the standalone BM25 functions + extension closure with the interface + `BM25Strategy` class. The existing `buildBM25Index`, `scoreBM25`, `tokenize`, `addWeightedTokens`, `buildDoc` functions stay — `BM25Strategy` wraps them.

- [ ] **Step 1: Add `SearchResult` and `SearchStrategy` types after `ToolEntry`**

In `tool-selector.ts`, after the `ToolEntry` interface, add:

```typescript
interface SearchResult {
  entry: ToolEntry;
  score: number;
}

interface SearchStrategy {
  search(query: string, limit: number): SearchResult[];
  scoreOne(entry: ToolEntry, query: string): number;
}
```

- [ ] **Step 2: Add `BM25Strategy` class after `scoreBM25`**

```typescript
// ---- BM25 Strategy --------------------------------------------------------

class BM25Strategy implements SearchStrategy {
  constructor(
    private readonly index: BM25Index,
    private readonly k1: number,
    private readonly b: number,
  ) {}

  search(query: string, limit: number): SearchResult[] {
    return scoreBM25(this.index, query, this.k1, this.b).slice(0, limit);
  }

  scoreOne(entry: ToolEntry, query: string): number {
    return scoreBM25(this.index, query, this.k1, this.b)
      .find(r => r.entry.name === entry.name)?.score ?? 0;
  }
}
```

- [ ] **Step 3: Update `Config` interface to add `strategy` and `pinnedTools`, update `DEFAULTS`, update `loadConfig`**

Replace the `Config` interface and `DEFAULTS`:

```typescript
interface Config {
  strategy: "bm25" | "regex";
  topK: number;
  pruneThreshold: number;
  pinnedTools: string[];
  bm25K1: number;
  bm25B: number;
  fieldWeights: { name: number; description: number; schemaKey: number };
}

const DEFAULTS: Config = {
  strategy: "bm25",
  topK: 5,
  pruneThreshold: 0.1,
  pinnedTools: [],
  bm25K1: 1.2,
  bm25B: 0.75,
  fieldWeights: { name: 6, description: 2, schemaKey: 1 },
};
```

Update `loadConfig` to include the new fields:

```typescript
function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return {
      strategy:       raw.strategy === "regex" ? "regex" : "bm25",
      topK:           raw.topK           ?? DEFAULTS.topK,
      pruneThreshold: raw.pruneThreshold ?? DEFAULTS.pruneThreshold,
      pinnedTools:    Array.isArray(raw.pinnedTools) ? raw.pinnedTools : [],
      bm25K1:         raw.bm25K1         ?? DEFAULTS.bm25K1,
      bm25B:          raw.bm25B          ?? DEFAULTS.bm25B,
      fieldWeights: {
        name:        raw.fieldWeights?.name        ?? DEFAULTS.fieldWeights.name,
        description: raw.fieldWeights?.description ?? DEFAULTS.fieldWeights.description,
        schemaKey:   raw.fieldWeights?.schemaKey   ?? DEFAULTS.fieldWeights.schemaKey,
      },
    };
  } catch (err) {
    console.warn("[tool-selector] failed to read tool-selector.json, using defaults:", err);
    return DEFAULTS;
  }
}
```

- [ ] **Step 4: Verify the file still loads**

```bash
echo "hello" | pi -p 2>&1 | grep "tool-selector"
```

Expected:
```
[tool-selector] indexed 248 tools, 15 builtins always active
```

- [ ] **Step 5: Commit**

```bash
cd ~/sandbox/pi/extensions
git add tool-selector.ts
git commit -m "feat: SearchStrategy interface + BM25Strategy class, add strategy/pinnedTools to config"
```

---

## Task 2: RegexStrategy + strategy factory

**Files:**
- Modify: `~/sandbox/pi/extensions/tool-selector.ts`

- [ ] **Step 1: Add `RegexStrategy` class after `BM25Strategy`**

```typescript
// ---- Regex Strategy -------------------------------------------------------

class RegexStrategy implements SearchStrategy {
  constructor(private readonly entries: ToolEntry[]) {}

  search(query: string, limit: number): SearchResult[] {
    return this.scoreAll(query).slice(0, limit);
  }

  scoreOne(entry: ToolEntry, query: string): number {
    let re: RegExp;
    try { re = new RegExp(query, "i"); } catch { return 0; }
    return this.score(entry, re);
  }

  private scoreAll(query: string): SearchResult[] {
    let re: RegExp;
    try { re = new RegExp(query, "i"); } catch { return []; }
    return this.entries
      .map(entry => ({ entry, score: this.score(entry, re) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  }

  private score(entry: ToolEntry, re: RegExp): number {
    let s = 0;
    if (re.test(entry.name)) s += 2;
    if (re.test(entry.description)) s += 1;
    for (const key of entry.schemaKeys) if (re.test(key)) s += 0.5;
    return s;
  }
}
```

- [ ] **Step 2: Add `buildStrategy` factory after `RegexStrategy`**

```typescript
// ---- Strategy Factory -----------------------------------------------------

function buildStrategy(entries: ToolEntry[], cfg: Config): SearchStrategy {
  if (cfg.strategy === "regex") return new RegexStrategy(entries);
  return new BM25Strategy(
    buildBM25Index(entries, cfg.fieldWeights),
    cfg.bm25K1,
    cfg.bm25B,
  );
}
```

- [ ] **Step 3: Smoke test both strategies**

Append to the file temporarily:

```typescript
// SMOKE TEST — remove before committing
(function smokeStrategies() {
  const entries: ToolEntry[] = [
    { name: "sqlite_list_tables", server: "sqlite", description: "List all tables in the SQLite database", schemaKeys: [] },
    { name: "castai_prod_master_get_node_metrics", server: "castai_prod_master", description: "Get CPU and memory metrics for a cluster node", schemaKeys: ["cluster_id", "metric_type"] },
  ];

  const bm25 = buildStrategy(entries, { ...DEFAULTS, strategy: "bm25" });
  const r1 = bm25.search("list tables", 5);
  console.assert(r1[0]?.entry.name === "sqlite_list_tables", "BM25 T1 failed: " + r1[0]?.entry.name);
  const r2 = bm25.search("cpu memory metrics", 5);
  console.assert(r2[0]?.entry.name === "castai_prod_master_get_node_metrics", "BM25 T2 failed: " + r2[0]?.entry.name);

  const regex = buildStrategy(entries, { ...DEFAULTS, strategy: "regex" });
  const r3 = regex.search("list_tables", 5);
  console.assert(r3[0]?.entry.name === "sqlite_list_tables", "Regex T1 failed: " + r3[0]?.entry.name);
  const r4 = regex.search("node.*metrics", 5);
  console.assert(r4[0]?.entry.name === "castai_prod_master_get_node_metrics", "Regex T2 failed: " + r4[0]?.entry.name);

  // scoreOne prune test
  const score = bm25.scoreOne(entries[1], "cpu memory");
  console.assert(score > 0, "scoreOne should return > 0 for relevant entry");
  const scoreZero = bm25.scoreOne(entries[1], "list tables sqlite");
  console.assert(scoreZero < 0.1, "scoreOne should return ~0 for irrelevant entry");

  console.log("[tool-selector] strategy smoke tests passed");
})();
```

Run:
```bash
echo "hello" | pi -p 2>&1 | grep -E "smoke|assert|failed|tool-selector"
```

Expected:
```
[tool-selector] strategy smoke tests passed
[tool-selector] indexed 248 tools, 15 builtins always active
```

- [ ] **Step 4: Remove smoke test, commit**

```bash
cd ~/sandbox/pi/extensions
git add tool-selector.ts
git commit -m "feat: RegexStrategy + buildStrategy factory"
```

---

## Task 3: Wire strategy into extension + pinnedTools + system prompt injection

**Files:**
- Modify: `~/sandbox/pi/extensions/tool-selector.ts`

Replace the extension closure to use `SearchStrategy` instead of calling `scoreBM25` directly. Add pinned tools and system prompt injection.

- [ ] **Step 1: Replace the extension export**

Replace the entire `// ---- Extension` section with:

```typescript
// ---- Extension ------------------------------------------------------------

export default function toolSelector(pi: ExtensionAPI) {
  let strategy: SearchStrategy | null = null;
  let builtins: string[] = [];
  let cfg: Config = DEFAULTS;
  let serverNames: string[] = [];
  const activeMcpTools = new Set<string>();

  function applyActiveTools(): void {
    try {
      pi.setActiveTools([...builtins, ...activeMcpTools]);
    } catch (err) {
      console.error("[tool-selector] setActiveTools failed:", err);
    }
  }

  pi.on("session_start", (_event) => {
    cfg = loadConfig();
    activeMcpTools.clear();

    const entries = loadToolEntries();
    if (entries.length === 0) {
      console.warn("[tool-selector] no tools loaded; falling back to mcp proxy");
      builtins = pi.getAllTools().map(t => t.name).filter(n => n !== "mcp");
      applyActiveTools();
      return;
    }

    serverNames = [...new Set(entries.map(e => e.server))];
    const mcpNames = new Set(entries.map(e => e.name));
    builtins = pi.getAllTools().map(t => t.name).filter(n => !mcpNames.has(n) && n !== "mcp");

    strategy = buildStrategy(entries, cfg);
    console.log(`[tool-selector] indexed ${entries.length} tools via ${cfg.strategy}, ${builtins.length} builtins, strategy=${cfg.strategy}`);

    // Pin specified tools immediately
    for (const name of cfg.pinnedTools) {
      if (mcpNames.has(name)) {
        activeMcpTools.add(name);
      } else {
        console.warn(`[tool-selector] pinnedTool "${name}" not found in index`);
      }
    }

    applyActiveTools();
  });

  pi.on("before_agent_start", (event) => {
    if (serverNames.length === 0) return {};
    return {
      systemPrompt: event.systemPrompt +
        `\n\nMCP servers available (call search_tool_bm25 to activate tools before using them): ${serverNames.join(", ")}.`,
    };
  });

  pi.registerTool({
    name: "search_tool_bm25",
    label: "Search MCP Tools",
    description: "Search for and activate relevant MCP tools by keyword. Call this before using any MCP capability. Active tools stay available until a new search re-scores them — tools scoring below threshold are deactivated. Pinned tools are never deactivated.",
    promptSnippet: "Search for MCP tools: search_tool_bm25({ query: \"cluster metrics cpu\" })",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Keywords describing the capability you need" },
        limit: { type: "number", description: "Max tools to activate (default: topK from config)" },
      },
      required: ["query"],
    } as never,
    execute: async (_toolCallId, params: { query?: string; limit?: number }) => {
      const query = (params.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text" as const, text: "Error: query must not be empty" }] };
      }
      if (!strategy) {
        return { content: [{ type: "text" as const, text: "Tool index not ready. Try again after session_start completes." }] };
      }

      const limit = params.limit ?? cfg.topK;
      const ranked = strategy.search(query, entries_count_placeholder);

      // Prune active MCP tools scoring below threshold (never prune pinned tools)
      const pinned = new Set(cfg.pinnedTools);
      const pruned: string[] = [];
      for (const name of [...activeMcpTools]) {
        if (pinned.has(name)) continue;
        const score = strategy.scoreOne({ name, server: "", description: "", schemaKeys: [] }, query);
        if (score < cfg.pruneThreshold) {
          activeMcpTools.delete(name);
          pruned.push(name);
        }
      }

      // Activate top-K not already active
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

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  });
}
```

**Note:** The prune logic uses `strategy.scoreOne` with a partial `ToolEntry` (only `name` matters — BM25Strategy looks up by name in the index, RegexStrategy uses name+description but we pass empty strings for already-active tools whose full entry we no longer have in the closure). Fix this by storing a `Map<string, ToolEntry>` in the closure. Replace the prune block with:

```typescript
// Store entries for pruning lookup (add this before session_start):
let entryByName = new Map<string, ToolEntry>();

// In session_start, after building strategy:
entryByName = new Map(entries.map(e => [e.name, e]));

// Prune block in execute:
for (const name of [...activeMcpTools]) {
  if (pinned.has(name)) continue;
  const entry = entryByName.get(name);
  if (!entry) { activeMcpTools.delete(name); pruned.push(name); continue; }
  const score = strategy.scoreOne(entry, query);
  if (score < cfg.pruneThreshold) {
    activeMcpTools.delete(name);
    pruned.push(name);
  }
}
```

Also remove the `entries_count_placeholder` — `strategy.search` takes `(query, limit)` and handles the limit internally. The ranked list is already top-K.

- [ ] **Step 2: The complete correct extension section**

The full extension export (no placeholders):

```typescript
export default function toolSelector(pi: ExtensionAPI) {
  let strategy: SearchStrategy | null = null;
  let builtins: string[] = [];
  let cfg: Config = DEFAULTS;
  let serverNames: string[] = [];
  let entryByName = new Map<string, ToolEntry>();
  const activeMcpTools = new Set<string>();

  function applyActiveTools(): void {
    try {
      pi.setActiveTools([...builtins, ...activeMcpTools]);
    } catch (err) {
      console.error("[tool-selector] setActiveTools failed:", err);
    }
  }

  pi.on("session_start", (_event) => {
    cfg = loadConfig();
    activeMcpTools.clear();
    entryByName.clear();

    const entries = loadToolEntries();
    if (entries.length === 0) {
      console.warn("[tool-selector] no tools loaded; falling back to mcp proxy");
      builtins = pi.getAllTools().map(t => t.name).filter(n => n !== "mcp");
      applyActiveTools();
      return;
    }

    serverNames = [...new Set(entries.map(e => e.server))];
    entryByName = new Map(entries.map(e => [e.name, e]));
    const mcpNames = new Set(entries.map(e => e.name));
    builtins = pi.getAllTools().map(t => t.name).filter(n => !mcpNames.has(n) && n !== "mcp");

    strategy = buildStrategy(entries, cfg);
    console.log(`[tool-selector] indexed ${entries.length} tools, strategy=${cfg.strategy}, builtins=${builtins.length}`);

    for (const name of cfg.pinnedTools) {
      if (mcpNames.has(name)) {
        activeMcpTools.add(name);
      } else {
        console.warn(`[tool-selector] pinnedTool "${name}" not found in index`);
      }
    }

    applyActiveTools();
  });

  pi.on("before_agent_start", (event) => {
    if (serverNames.length === 0) return {};
    return {
      systemPrompt: event.systemPrompt +
        `\n\nMCP servers available (call search_tool_bm25 to activate tools before using them): ${serverNames.join(", ")}.`,
    };
  });

  pi.registerTool({
    name: "search_tool_bm25",
    label: "Search MCP Tools",
    description: "Search for and activate relevant MCP tools by keyword. Call this before using any MCP capability. Active tools stay available until a new search re-scores them — tools scoring below threshold are deactivated. Pinned tools are never deactivated.",
    promptSnippet: "Search for MCP tools: search_tool_bm25({ query: \"cluster metrics cpu\" })",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Keywords describing the capability you need" },
        limit: { type: "number", description: "Max tools to activate (default: topK from config)" },
      },
      required: ["query"],
    } as never,
    execute: async (_toolCallId, params: { query?: string; limit?: number }) => {
      const query = (params.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text" as const, text: "Error: query must not be empty" }] };
      }
      if (!strategy) {
        return { content: [{ type: "text" as const, text: "Tool index not ready." }] };
      }

      const limit = params.limit ?? cfg.topK;
      const ranked = strategy.search(query, limit);

      const pinned = new Set(cfg.pinnedTools);
      const pruned: string[] = [];
      for (const name of [...activeMcpTools]) {
        if (pinned.has(name)) continue;
        const entry = entryByName.get(name);
        if (!entry) { activeMcpTools.delete(name); pruned.push(name); continue; }
        const score = strategy.scoreOne(entry, query);
        if (score < cfg.pruneThreshold) {
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

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  });
}
```

- [ ] **Step 3: Verify extension loads**

```bash
echo "hello" | pi -p 2>&1 | grep "tool-selector"
```

Expected:
```
[tool-selector] indexed 248 tools, strategy=bm25, builtins=15
```

- [ ] **Step 4: Verify pinnedTools works**

Create `~/.pi/agent/tool-selector.json`:
```json
{ "pinnedTools": ["sqlite_list_tables"] }
```

```bash
echo "hello" | pi -p 2>&1 | grep "tool-selector"
```

Then immediately in pi: ask `what tools do I have active?` — model should see `sqlite_list_tables` without searching.

Remove the config file after verifying (or set `pinnedTools: []`).

- [ ] **Step 5: Verify system prompt injection**

```bash
echo "list sql tables" | pi -p 2>&1 | grep -i "search_tool_bm25\|mcp server"
```

Expected: model calls `search_tool_bm25` because the system prompt told it servers are available.

- [ ] **Step 6: Verify regex strategy**

Create `~/.pi/agent/tool-selector.json`:
```json
{ "strategy": "regex" }
```

```bash
echo "hello" | pi -p 2>&1 | grep "tool-selector"
```

Expected:
```
[tool-selector] indexed 248 tools, strategy=regex, builtins=15
```

Then test: `search for tools matching sqlite.*list` — should activate `sqlite_list_tables`.

Remove or reset the config file after verifying.

- [ ] **Step 7: Commit**

```bash
cd ~/sandbox/pi/extensions
git add tool-selector.ts
git commit -m "feat: swappable strategy, pinnedTools, system prompt server hint"
```

---

## Complete Final File

The assembled file after all tasks (for reference):

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

interface SearchResult {
  entry: ToolEntry;
  score: number;
}

interface SearchStrategy {
  search(query: string, limit: number): SearchResult[];
  scoreOne(entry: ToolEntry, query: string): number;
}

// ---- Config ---------------------------------------------------------------

interface Config {
  strategy: "bm25" | "regex";
  topK: number;
  pruneThreshold: number;
  pinnedTools: string[];
  bm25K1: number;
  bm25B: number;
  fieldWeights: { name: number; description: number; schemaKey: number };
}

const DEFAULTS: Config = {
  strategy: "bm25",
  topK: 5,
  pruneThreshold: 0.1,
  pinnedTools: [],
  bm25K1: 1.2,
  bm25B: 0.75,
  fieldWeights: { name: 6, description: 2, schemaKey: 1 },
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "tool-selector.json");
const CACHE_PATH  = join(homedir(), ".pi", "agent", "mcp-cache.json");

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return {
      strategy:       raw.strategy === "regex" ? "regex" : "bm25",
      topK:           raw.topK           ?? DEFAULTS.topK,
      pruneThreshold: raw.pruneThreshold ?? DEFAULTS.pruneThreshold,
      pinnedTools:    Array.isArray(raw.pinnedTools) ? raw.pinnedTools : [],
      bm25K1:         raw.bm25K1         ?? DEFAULTS.bm25K1,
      bm25B:          raw.bm25B          ?? DEFAULTS.bm25B,
      fieldWeights: {
        name:        raw.fieldWeights?.name        ?? DEFAULTS.fieldWeights.name,
        description: raw.fieldWeights?.description ?? DEFAULTS.fieldWeights.description,
        schemaKey:   raw.fieldWeights?.schemaKey   ?? DEFAULTS.fieldWeights.schemaKey,
      },
    };
  } catch (err) {
    console.warn("[tool-selector] failed to read tool-selector.json, using defaults:", err);
    return DEFAULTS;
  }
}

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

function buildDoc(entry: ToolEntry, weights: Config["fieldWeights"]): BM25Doc {
  const tf = new Map<string, number>();
  addWeightedTokens(tf, entry.name, weights.name);
  addWeightedTokens(tf, entry.description, weights.description);
  for (const key of entry.schemaKeys) {
    addWeightedTokens(tf, key, weights.schemaKey);
  }
  const length = Array.from(tf.values()).reduce((s, v) => s + v, 0);
  return { entry, termFreq: tf, length };
}

function buildBM25Index(entries: ToolEntry[], weights: Config["fieldWeights"]): BM25Index {
  const docs = entries.map(e => buildDoc(e, weights));
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

function scoreBM25(index: BM25Index, query: string, k1: number, b: number): SearchResult[] {
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
        const norm = k1 * (1 - b + b * (doc.length / index.avgLength));
        score += idf * (tf * (k1 + 1)) / (tf + norm);
      }
      return { entry: doc.entry, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
}

// ---- BM25 Strategy --------------------------------------------------------

class BM25Strategy implements SearchStrategy {
  constructor(
    private readonly index: BM25Index,
    private readonly k1: number,
    private readonly b: number,
  ) {}

  search(query: string, limit: number): SearchResult[] {
    return scoreBM25(this.index, query, this.k1, this.b).slice(0, limit);
  }

  scoreOne(entry: ToolEntry, query: string): number {
    return scoreBM25(this.index, query, this.k1, this.b)
      .find(r => r.entry.name === entry.name)?.score ?? 0;
  }
}

// ---- Regex Strategy -------------------------------------------------------

class RegexStrategy implements SearchStrategy {
  constructor(private readonly entries: ToolEntry[]) {}

  search(query: string, limit: number): SearchResult[] {
    return this.scoreAll(query).slice(0, limit);
  }

  scoreOne(entry: ToolEntry, query: string): number {
    let re: RegExp;
    try { re = new RegExp(query, "i"); } catch { return 0; }
    return this.score(entry, re);
  }

  private scoreAll(query: string): SearchResult[] {
    let re: RegExp;
    try { re = new RegExp(query, "i"); } catch { return []; }
    return this.entries
      .map(entry => ({ entry, score: this.score(entry, re) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  }

  private score(entry: ToolEntry, re: RegExp): number {
    let s = 0;
    if (re.test(entry.name)) s += 2;
    if (re.test(entry.description)) s += 1;
    for (const key of entry.schemaKeys) if (re.test(key)) s += 0.5;
    return s;
  }
}

// ---- Strategy Factory -----------------------------------------------------

function buildStrategy(entries: ToolEntry[], cfg: Config): SearchStrategy {
  if (cfg.strategy === "regex") return new RegexStrategy(entries);
  return new BM25Strategy(buildBM25Index(entries, cfg.fieldWeights), cfg.bm25K1, cfg.bm25B);
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
  let strategy: SearchStrategy | null = null;
  let builtins: string[] = [];
  let cfg: Config = DEFAULTS;
  let serverNames: string[] = [];
  let entryByName = new Map<string, ToolEntry>();
  const activeMcpTools = new Set<string>();

  function applyActiveTools(): void {
    try {
      pi.setActiveTools([...builtins, ...activeMcpTools]);
    } catch (err) {
      console.error("[tool-selector] setActiveTools failed:", err);
    }
  }

  pi.on("session_start", (_event) => {
    cfg = loadConfig();
    activeMcpTools.clear();
    entryByName = new Map();

    const entries = loadToolEntries();
    if (entries.length === 0) {
      console.warn("[tool-selector] no tools loaded; falling back to mcp proxy");
      builtins = pi.getAllTools().map(t => t.name).filter(n => n !== "mcp");
      applyActiveTools();
      return;
    }

    serverNames = [...new Set(entries.map(e => e.server))];
    entryByName = new Map(entries.map(e => [e.name, e]));
    const mcpNames = new Set(entries.map(e => e.name));
    builtins = pi.getAllTools().map(t => t.name).filter(n => !mcpNames.has(n) && n !== "mcp");

    strategy = buildStrategy(entries, cfg);
    console.log(`[tool-selector] indexed ${entries.length} tools, strategy=${cfg.strategy}, builtins=${builtins.length}`);

    for (const name of cfg.pinnedTools) {
      if (mcpNames.has(name)) {
        activeMcpTools.add(name);
      } else {
        console.warn(`[tool-selector] pinnedTool "${name}" not found in index`);
      }
    }

    applyActiveTools();
  });

  pi.on("before_agent_start", (event) => {
    if (serverNames.length === 0) return {};
    return {
      systemPrompt: event.systemPrompt +
        `\n\nMCP servers available (call search_tool_bm25 to activate tools before using them): ${serverNames.join(", ")}.`,
    };
  });

  pi.registerTool({
    name: "search_tool_bm25",
    label: "Search MCP Tools",
    description: "Search for and activate relevant MCP tools by keyword. Call this before using any MCP capability. Active tools stay available until a new search re-scores them — tools scoring below threshold are deactivated. Pinned tools are never deactivated.",
    promptSnippet: "Search for MCP tools: search_tool_bm25({ query: \"cluster metrics cpu\" })",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Keywords describing the capability you need" },
        limit: { type: "number", description: "Max tools to activate (default: topK from config)" },
      },
      required: ["query"],
    } as never,
    execute: async (_toolCallId, params: { query?: string; limit?: number }) => {
      const query = (params.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text" as const, text: "Error: query must not be empty" }] };
      }
      if (!strategy) {
        return { content: [{ type: "text" as const, text: "Tool index not ready." }] };
      }

      const limit = params.limit ?? cfg.topK;
      const ranked = strategy.search(query, limit);

      const pinned = new Set(cfg.pinnedTools);
      const pruned: string[] = [];
      for (const name of [...activeMcpTools]) {
        if (pinned.has(name)) continue;
        const entry = entryByName.get(name);
        if (!entry) { activeMcpTools.delete(name); pruned.push(name); continue; }
        const score = strategy.scoreOne(entry, query);
        if (score < cfg.pruneThreshold) {
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

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  });
}
```
