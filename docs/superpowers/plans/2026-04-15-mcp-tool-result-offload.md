# MCP Tool Result Offload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an MCP tool result exceeds `maxToolResultChars` characters, save the full result to a file and return the path to the model instead of bloating context.

**Architecture:** Replace `applyTruncation` in `proxy-modes.ts` with `applyOffload`, which writes large results to `<session-dir>/tool-results/<uuid>.<ext>` and returns a path + instructions block. Thread `ctx: ExtensionContext` and `maxToolResultChars: number` from `index.ts` into `executeCall`. Add `maxToolResultChars` to `src/config.ts`.

**Tech Stack:** Node.js fs (sync), `node:os`, `node:path`, `node:crypto` (uuid via randomUUID), TypeScript

---

## File Structure

| File | Change |
|---|---|
| `src/config.ts` | Add `maxToolResultChars?: number` to `KimchiConfig`; read from config JSON; default `10_000` |
| `src/extensions/mcp-adapter/proxy-modes.ts` | Add `applyOffload`; update `executeCall` signature to accept `ctx` and `maxToolResultChars`; replace `applyTruncation` call |
| `src/extensions/mcp-adapter/index.ts` | Import `loadConfig` from `../../config.js`; rename `_ctx` → `ctx`; pass `ctx` and `maxToolResultChars` to `executeCall` |

---

### Task 1: Add `maxToolResultChars` to `src/config.ts`

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add field to `KimchiConfig` interface**

In `src/config.ts`, add `maxToolResultChars` to the interface and return it in `loadConfig`:

```typescript
export interface KimchiConfig {
    apiKey: string
    agentConfigDir: string
    llmEndpoint: string
    maxToolResultChars: number
}
```

- [ ] **Step 2: Read field in `readApiKeyFromConfigFile` and surface in `loadConfig`**

`loadConfig` currently returns hardcoded values. Add reading of `maxToolResultChars` from the parsed config JSON:

```typescript
function readConfigExtras(configPath: string): { maxToolResultChars?: number } {
    try {
        const raw = readFileSync(configPath, "utf-8")
        const parsed = JSON.parse(raw)
        const val = parsed.maxToolResultChars
        return { maxToolResultChars: typeof val === "number" && val > 0 ? val : undefined }
    } catch {
        return {}
    }
}
```

Then in `loadConfig`, before throwing on missing API key — and in both early-return branches — compute extras and include `maxToolResultChars`:

```typescript
export function loadConfig(options?: { configPath?: string; env?: Record<string, string | undefined> }): KimchiConfig {
    const env = options?.env ?? process.env
    const configPath = options?.configPath ?? KIMCHI_CONFIG_PATH
    const extras = readConfigExtras(configPath)
    const maxToolResultChars = extras.maxToolResultChars ?? 10_000

    const envKey = env.KIMCHI_API_KEY
    if (typeof envKey === "string" && envKey.length > 0) {
        return {
            apiKey: envKey,
            agentConfigDir: AGENT_CONFIG_DIR,
            llmEndpoint: CAST_AI_LLM_ENDPOINT,
            maxToolResultChars,
        }
    }

    const fileKey = readApiKeyFromConfigFile(configPath)
    if (fileKey) {
        return {
            apiKey: fileKey,
            agentConfigDir: AGENT_CONFIG_DIR,
            llmEndpoint: CAST_AI_LLM_ENDPOINT,
            maxToolResultChars,
        }
    }

    throw new Error(
        "No Kimchi API key found. Set the KIMCHI_API_KEY environment variable or log in with the kimchi CLI (`kimchi auth login`).",
    )
}
```

Note: `readApiKeyFromConfigFile` is still needed for the API key; `readConfigExtras` is a new helper that reads the full parsed config once. Both read the same file — this is fine; config reads happen once at startup.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "feat: add maxToolResultChars to KimchiConfig (default 10k)"
```

---

### Task 2: Add `applyOffload` to `proxy-modes.ts` and thread `ctx`/`maxToolResultChars` through `executeCall`

**Files:**
- Modify: `src/extensions/mcp-adapter/proxy-modes.ts`

- [ ] **Step 1: Add imports**

At the top of `proxy-modes.ts`, add:

```typescript
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import type { ExtensionContext } from "@mariozechner/pi-coding-agent"
```

- [ ] **Step 2: Add `applyOffload` function**

Add after the existing `applyTruncation` function (keep `applyTruncation` for now — it will be removed in a later step):

```typescript
function applyOffload(
    content: ContentBlock[],
    toolName: string,
    maxChars: number,
    ctx: ExtensionContext,
): ContentBlock[] {
    const textItems = content.filter((c): c is TextContent => c.type === "text")
    if (textItems.length === 0) return content

    const combined = textItems.map((c) => c.text).join("\n")
    if (combined.length <= maxChars) return content

    const nonText = content.filter((c) => c.type !== "text")

    // Lightweight format detection — avoids JSON.parse on large strings
    const ext = /^\s*[\{\[]/.test(combined) ? "json" : "txt"

    // Derive output directory from session file
    let dir: string
    const sessionFile = ctx.sessionManager.getSessionFile()
    if (sessionFile) {
        dir = join(dirname(sessionFile), "tool-results")
    } else {
        dir = join(tmpdir(), `kimchi-tool-results-${userInfo().uid}`)
    }

    let path: string
    try {
        mkdirSync(dir, { recursive: true })
        path = join(dir, `${randomUUID()}.${ext}`)
        writeFileSync(path, combined, "utf-8")
    } catch (err) {
        console.warn(`[mcp-adapter] applyOffload: failed to write tool result to disk:`, err)
        // Hard-slice fallback — do NOT use truncateTail; it fails on single-line blobs
        const sliced = combined.slice(0, maxChars) + "\n\n... [Truncated due to I/O error]"
        return [...nonText, { type: "text" as const, text: sliced }]
    }

    const format = ext === "json" ? "JSON" : "Plain text"
    const message = `result (${combined.length.toLocaleString()} characters) exceeds limit. Full output saved to ${path}.
Format: ${format}
- To search: use bash with grep on the file directly
- To read in chunks: bash -c "python3 -c \\"print(open('${path}').read()[A:B])\\""
- For analysis requiring full content: use a subagent with the file path`

    return [...nonText, { type: "text" as const, text: message }]
}
```

- [ ] **Step 3: Update `executeCall` signature to accept `ctx` and `maxToolResultChars`**

Change the signature at line 488:

```typescript
export async function executeCall(
    state: McpExtensionState,
    toolName: string,
    args?: Record<string, unknown>,
    serverOverride?: string,
    ctx?: ExtensionContext,
    maxToolResultChars?: number,
): Promise<ProxyToolResult>
```

- [ ] **Step 4: Replace `applyTruncation` call with `applyOffload`**

Find line 830 (the `applyTruncation` call):

```typescript
const truncated = applyTruncation((content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }]) as ContentBlock[])
```

Replace with:

```typescript
const finalContent = (content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }]) as ContentBlock[]
const truncated = ctx
    ? applyOffload(finalContent, toolName, maxToolResultChars ?? 10_000, ctx)
    : applyTruncation(finalContent)
```

This keeps `applyTruncation` as a safe fallback when `ctx` is not provided (e.g., callers that haven't been updated yet, like `direct-tools.ts`).

- [ ] **Step 5: Typecheck**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/extensions/mcp-adapter/proxy-modes.ts
git commit -m "feat: add applyOffload to proxy-modes, thread ctx/maxToolResultChars through executeCall"
```

---

### Task 3: Wire up in `index.ts`

**Files:**
- Modify: `src/extensions/mcp-adapter/index.ts`

- [ ] **Step 1: Import `loadConfig`**

Add to the imports at the top of `index.ts`:

```typescript
import { loadConfig } from "../../config.js"
```

- [ ] **Step 2: Rename `_ctx` to `ctx` and pass it to `executeCall`**

At line 280, change the handler signature parameter from `_ctx` to `ctx`:

```typescript
    async (
        params: { ... },
        _signal,
        _onUpdate,
        ctx,  // was: _ctx
    ) {
```

- [ ] **Step 3: Read `maxToolResultChars` and pass to `executeCall`**

Before the `if (params.tool)` block (around line 319), read the config value (handle failure gracefully so MCP tools still work if config can't be loaded):

```typescript
let maxToolResultChars = 10_000
try {
    const kimchiConfig = loadConfig()
    maxToolResultChars = kimchiConfig.maxToolResultChars
} catch {
    // loadConfig throws when API key is missing; default is fine here
}
```

Then change the `executeCall` call at line 320:

```typescript
if (params.tool) {
    return executeCall(state, params.tool, parsedArgs, params.server, ctx, maxToolResultChars)
}
```

- [ ] **Step 4: Typecheck**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/extensions/mcp-adapter/index.ts
git commit -m "feat: wire maxToolResultChars and ctx into executeCall in index.ts"
```

---

### Task 4: End-to-end verification

- [ ] **Step 1: Build binary**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm build:binary
```

Expected: build succeeds, binary at `./dist/kimchi` (or equivalent output path).

- [ ] **Step 2: Start a session and run a Loki query**

Run the binary and use the Grafana MCP's `query_loki_logs` (or similar) to fetch a large result. The session JSONL path is printed on session start.

- [ ] **Step 3: Confirm token counts stayed low**

Check the session JSONL: tool result entries should be short path messages, not 51KB blobs. The conversation token count should stay under ~3k, not spike to 31k.

- [ ] **Step 4: Confirm file written to session tool-results dir**

```bash
ls <session-dir>/tool-results/
```

Expected: one or more `.json` or `.txt` files.

- [ ] **Step 5: Confirm model uses bash/grep to read**

Check the session — the model should respond by calling bash with grep or a slice on the file path, not by repeating the large content.

- [ ] **Step 6: Test I/O failure fallback (optional)**

Temporarily make `dir` a path without write permission (e.g. `/root/nope`), run a large query, confirm the hard-slice message appears instead of a crash.

- [ ] **Step 7: Confirm configurable threshold works**

Add `"maxToolResultChars": 500` to `~/.config/kimchi/config.json`, run a query that returns >500 chars, confirm offload triggers at 500 chars.

---

## Notes

- `applyTruncation` is kept as dead code for now — it serves as the fallback in `executeCall` when `ctx` is `undefined` (e.g. from `direct-tools.ts`). Remove it in the follow-up PR when `direct-tools.ts` is updated.
- The `direct-tools.ts` gap (also executes MCP calls) is out of scope per the spec; follow-up PR should extract `applyOffload` to a shared utility and use it there too.
- `randomUUID()` from `node:crypto` is available in Node 14.17+ and Bun; no extra dependency needed.
