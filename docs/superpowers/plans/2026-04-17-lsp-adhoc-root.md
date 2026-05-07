# LSP Ad-hoc File Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LSP tools work on files outside sessionCwd by using the file's directory as the LSP root instead of sessionCwd.

**Architecture:** Add a `clientCwd(filePath, sessionCwd)` helper in `extensions/lsp.ts` that returns `sessionCwd` when the file is under it, or `path.dirname(filePath)` otherwise. All 5 tool execute functions use this instead of bare `cwd`.

**Tech Stack:** TypeScript, Bun, existing LSP extension infrastructure.

---

## File Structure

- Modify: `extensions/lsp.ts` — add `clientCwd` helper, update 5 tool handlers
- Test: `src/extensions/lsp/lsp-entry.test.ts` — unit tests for `clientCwd`

---

### Task 1: Extract and test `clientCwd`

**Files:**
- Modify: `extensions/lsp.ts`
- Create: `src/extensions/lsp/lsp-entry.test.ts`

- [ ] **Step 1: Add `clientCwd` to `extensions/lsp.ts`**

Add after the imports, before `export default function`:

```typescript
export function clientCwd(filePath: string, sessionCwd: string): string {
	if (filePath.startsWith(sessionCwd + path.sep) || filePath === sessionCwd) return sessionCwd
	return path.dirname(filePath)
}
```

- [ ] **Step 2: Write failing tests**

Create `src/extensions/lsp/lsp-entry.test.ts`:

```typescript
import path from "node:path"
import { describe, expect, it } from "vitest"
import { clientCwd } from "../../../extensions/lsp.js"

describe("clientCwd", () => {
	it("returns sessionCwd for file inside it", () => {
		expect(clientCwd("/repo/src/foo.ts", "/repo")).toBe("/repo")
	})

	it("returns sessionCwd for file at sessionCwd root", () => {
		expect(clientCwd("/repo/foo.ts", "/repo")).toBe("/repo")
	})

	it("returns file directory for file outside sessionCwd", () => {
		expect(clientCwd("/tmp/test.ts", "/repo")).toBe("/tmp")
	})

	it("does not match sessionCwd as prefix of unrelated path", () => {
		expect(clientCwd("/repo-other/foo.ts", "/repo")).toBe("/repo-other")
	})

	it("returns file directory for deeply nested outside file", () => {
		expect(clientCwd("/tmp/gotest/main.go", "/repo")).toBe("/tmp/gotest")
	})
})
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm vitest run src/extensions/lsp/lsp-entry.test.ts 2>&1 | tail -15
```

Expected: FAIL — `clientCwd` not exported yet (import error).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm vitest run src/extensions/lsp/lsp-entry.test.ts 2>&1 | tail -15
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/ibar/castai/src/kimchi-dev
git add extensions/lsp.ts src/extensions/lsp/lsp-entry.test.ts
git commit -m "feat(lsp): add clientCwd helper for ad-hoc file support"
```

---

### Task 2: Wire `clientCwd` into all 5 tools

**Files:**
- Modify: `extensions/lsp.ts`

- [ ] **Step 1: Update all 5 `getOrCreateClient` calls**

In each of the 5 tool `execute` functions, replace:
```typescript
const client = await getOrCreateClient(server, cwd)
```
with:
```typescript
const client = await getOrCreateClient(server, clientCwd(filePath, cwd))
```

There are exactly 5 occurrences — one per tool (`lsp_diagnostics`, `lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_rename`).

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm tsc --noEmit 2>&1 | head -20
```

Expected: no output (clean).

- [ ] **Step 3: Run all tests**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm test 2>&1 | tail -10
```

Expected: all tests pass including the 5 new `clientCwd` tests.

- [ ] **Step 4: Commit**

```bash
cd /Users/ibar/castai/src/kimchi-dev
git add extensions/lsp.ts
git commit -m "feat(lsp): use clientCwd in all tools to support ad-hoc files outside sessionCwd"
```
