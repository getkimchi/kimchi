# User-Agent Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject `User-Agent: kimchi/<version>` on every outgoing HTTP request via an undici dispatcher interceptor, removing hardcoded UA strings from model config and web-fetch.

**Architecture:** Wrap the existing `EnvHttpProxyAgent` in `src/cli.ts` with a `compose()` interceptor that sets the `user-agent` header before dispatch. Version is read once via `getVersion()` from `src/utils.ts`, which reads `package.json` (patched to the git tag at release time by `scripts/set-version.js`).

**Tech Stack:** undici (already a dependency), vitest, TypeScript

---

### Task 1: Remove `headers` from model provider config

**Files:**
- Modify: `src/models.ts:48`
- Modify: `src/models.test.ts` (update any assertions about `headers` in provider config)

- [ ] **Step 1: Remove the `headers` field from `buildModelsConfig`**

In `src/models.ts`, change:

```ts
"kimchi-dev": {
    baseUrl: CAST_AI_LLM_BASE_URL,
    apiKey: "KIMCHI_API_KEY",
    api: "openai-completions",
    authHeader: true,
    headers: { "User-Agent": "kimchi/0.0.1" },
    models: models.map((id) => ({
```

to:

```ts
"kimchi-dev": {
    baseUrl: CAST_AI_LLM_BASE_URL,
    apiKey: "KIMCHI_API_KEY",
    api: "openai-completions",
    authHeader: true,
    models: models.map((id) => ({
```

- [ ] **Step 2: Run existing tests to verify nothing broke**

```bash
cd /Users/ibar/castai/src/kimchi-dev
pnpm run test -- src/models.test.ts
```

Expected: all tests pass (no test checks for the `headers` field in provider config).

- [ ] **Step 3: Commit**

```bash
git add src/models.ts
git commit -m "refactor: remove hardcoded User-Agent from model provider config"
```

---

### Task 2: Remove hardcoded User-Agent from web-fetch

**Files:**
- Modify: `src/extensions/web-fetch/page-fetcher.ts:252-254`

- [ ] **Step 1: Remove the `User-Agent` line, keep the `Accept` header**

In `src/extensions/web-fetch/page-fetcher.ts`, change:

```ts
headers: {
    "User-Agent": "kimchi-web-fetch/0.1",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
},
```

to:

```ts
headers: {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
},
```

- [ ] **Step 2: Run type check**

```bash
pnpm run check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/extensions/web-fetch/page-fetcher.ts
git commit -m "refactor: remove hardcoded User-Agent from web-fetch"
```

---

### Task 3: Inject User-Agent via undici dispatcher interceptor

**Files:**
- Modify: `src/cli.ts` (around line 143 where `setGlobalDispatcher` is called)

- [ ] **Step 1: Add `getVersion` import to `src/cli.ts`**

At the top of `src/cli.ts`, add to existing local imports:

```ts
import { getVersion } from "./utils.js"
```

- [ ] **Step 2: Replace the `setGlobalDispatcher` call with an interceptor-wrapped dispatcher**

Find this block in `src/cli.ts`:

```ts
// Set up HTTP proxy support
const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici")
setGlobalDispatcher(new EnvHttpProxyAgent())
```

Replace with:

```ts
// Set up HTTP proxy support with User-Agent injection
const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici")
const userAgent = `kimchi/${getVersion()}`
const agent = new EnvHttpProxyAgent()
setGlobalDispatcher(
    agent.compose((dispatch) => (opts, handler) => {
        const headers = new Headers(opts.headers as HeadersInit)
        headers.set("user-agent", userAgent)
        return dispatch({ ...opts, headers: Object.fromEntries(headers) }, handler)
    }),
)
```

- [ ] **Step 3: Build and type check**

```bash
pnpm run build
pnpm run check
```

Expected: clean compile, no type errors.

- [ ] **Step 4: Run all tests**

```bash
pnpm run test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat: inject User-Agent header via undici dispatcher interceptor"
```

---

### Task 4: Verify end-to-end

- [ ] **Step 1: Build the binary**

```bash
pnpm run build:binary
```

- [ ] **Step 2: Confirm version string is correct**

```bash
./dist/bin/kimchi-code --version
```

Expected: prints the current version from `package.json`.

- [ ] **Step 3: (Optional) Confirm header is sent**

Run with a proxy or capture via `mitmproxy` / `curl --proxy`. Every request to `llm.kimchi.dev` should include `User-Agent: kimchi/<version>`.
