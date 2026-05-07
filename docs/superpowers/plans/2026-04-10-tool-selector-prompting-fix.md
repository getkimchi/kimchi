# Tool Selector Prompting Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the tool-selector extension so the model calls MCP tools after `search_tool_bm25` activates them, by improving the system prompt and search result output.

**Architecture:** Two text changes in `tool-selector.ts`: (1) replace the vague system prompt with explicit two-turn workflow instructions, (2) strip search result output to essentials with a positive stop directive. No architectural changes.

**Tech Stack:** TypeScript, Pi `ExtensionAPI` (`@mariozechner/pi-coding-agent`)

---

## File Map

| Action | Path |
|---|---|
| Modify | `~/.pi/agent/extensions/tool-selector.ts` |

No other files touched.

---

## Task 1: System Prompt — Two-Turn Workflow

**Files:**
- Modify: `~/.pi/agent/extensions/tool-selector.ts:348-351`

- [ ] **Step 1: Replace the system prompt injection in `before_agent_start`**

Replace lines 348-351:

```typescript
    return {
      systemPrompt: (event.systemPrompt ?? "") +
        `\n\nMCP servers available (call search_tool_bm25 to activate tools before using them): ${serverNames.join(", ")}.`,
    };
```

With:

```typescript
    return {
      systemPrompt: (event.systemPrompt ?? "") +
        `\n\n## MCP Tool Discovery\n\nYou have access to MCP servers: ${serverNames.join(", ")}. Their tools are NOT visible yet.\n\nWorkflow:\n1. Call search_tool_bm25({ query: "keywords" }) to find and activate relevant tools\n2. After search completes, the activated tools become available as direct tool calls on your NEXT response\n3. After calling search_tool_bm25, end your response. The tools become available on your next turn.`,
    };
```

- [ ] **Step 2: Verify the extension still loads**

Run:
```bash
echo "hello" | pi -p --extension ~/.pi/agent/extensions/tool-selector.ts 2>&1 | grep "tool-selector"
```

Expected: `[tool-selector] indexed N tools` with no errors.

- [ ] **Step 3: Commit**

```bash
cd ~/.pi/agent/extensions
git add tool-selector.ts
git commit -m "fix: explicit two-turn workflow in system prompt for MCP tool discovery"
```

---

## Task 2: Search Result Output — Strip to Essentials

**Files:**
- Modify: `~/.pi/agent/extensions/tool-selector.ts:417-432`

- [ ] **Step 1: Replace the search result output formatting**

Replace lines 417-432 (the output formatting block inside `execute`):

```typescript
      const registered = new Set(pi.getAllTools().map(t => t.name));
      const lines: string[] = [];
      if (activated.length > 0) {
        const details = activated.map(name => {
          const entry = entryByName.get(name);
          const sig = entry?.requiredKeys.length ? `(required: ${entry.requiredKeys.join(", ")})` : "";
          const ready = registered.has(name) ? "" : " [not ready yet — MCP server still initializing]";
          return `  ${name}${sig}${ready}`;
        });
        lines.push(`Activated (${activated.length}):\n${details.join("\n")}`);
      }
      if (pruned.length > 0) lines.push(`Pruned (${pruned.length}): ${pruned.join(", ")}`);
      const readyActive = [...activeMcpTools].filter(n => registered.has(n));
      const pendingActive = [...activeMcpTools].filter(n => !registered.has(n));
      lines.push(`Active MCP tools: ${readyActive.length > 0 ? readyActive.join(", ") : "(none)"}`);
      if (pendingActive.length > 0) lines.push(`Pending (MCP server initializing): ${pendingActive.join(", ")}`);
```

With:

```typescript
      const lines: string[] = [];
      if (activated.length > 0) {
        const details = activated.map(name => {
          const entry = entryByName.get(name);
          const sig = entry?.requiredKeys.length ? `(required: ${entry.requiredKeys.join(", ")})` : "";
          return `  ${name}${sig}`;
        });
        lines.push(`Activated (${activated.length}):\n${details.join("\n")}`);
      }
      if (pruned.length > 0) lines.push(`Pruned (${pruned.length}): ${pruned.join(", ")}`);
      lines.push(`\nThese tools are now available as direct tool calls in your next response.`);
```

- [ ] **Step 2: Verify the extension still loads and search works**

Run:
```bash
echo "hello" | pi -p --extension ~/.pi/agent/extensions/tool-selector.ts 2>&1 | grep "tool-selector"
```

Expected: `[tool-selector] indexed N tools` with no errors.

- [ ] **Step 3: Commit**

```bash
cd ~/.pi/agent/extensions
git add tool-selector.ts
git commit -m "fix: strip search output to essentials with positive stop directive"
```

---

## Task 3: Manual Integration Test

**Files:**
- No code changes — test only.

- [ ] **Step 1: Start a Pi session with tool-selector**

```bash
pi --extension ~/.pi/agent/extensions/tool-selector.ts
```

- [ ] **Step 2: Test the two-turn workflow**

Ask: `query the prod master loki logs for ai-optimizer service over the last 1 minute`

Expected behavior:
1. Model calls `search_tool_bm25({ query: "loki logs query" })` or similar
2. Search result shows activated tools with "available as direct tool calls in your next response"
3. Model ends its response (does NOT try shell commands or mcp-cli)
4. On the next turn, model calls `grafana_prod_master_query_loki_logs` directly with proper parameters

- [ ] **Step 3: Test pruning still works**

In the same session ask: `search for kubernetes cluster metrics`

Expected: loki tools get pruned, castai/kubernetes tools get activated.

- [ ] **Step 4: Verify output truncation**

In the same session, run a query that returns large output. Verify the `[... N chars truncated ...]` message appears for responses over 20K chars.
