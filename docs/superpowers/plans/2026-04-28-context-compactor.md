# Context Compactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `context-compactor` extension that prunes old tool result messages mid-session to prevent per-turn input tokens from growing unbounded, fixing `AgentTimeoutError` on 15-minute benchmark runs.

**Architecture:** Two exported pure functions (`computeCutoff`, `pruneToolResult`) contain all the logic and are unit-tested independently. The extension default export wires them to `message_end` (to track actual input tokens) and `context` (to prune before each LLM call). Registered in `src/cli.ts` alongside the other extensions.

**Tech Stack:** TypeScript, Vitest, `@mariozechner/pi-ai` (types: `AssistantMessage`, `ToolResultMessage`, `TextContent`), `@mariozechner/pi-coding-agent` (`ExtensionAPI`, `AgentMessage`)

---

### Task 1: Pure logic + unit tests

**Files:**
- Create: `src/extensions/context-compactor.ts`
- Create: `src/extensions/context-compactor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/extensions/context-compactor.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { computeCutoff, pruneToolResult } from "./context-compactor.js"
import type { ToolResultMessage } from "@mariozechner/pi-ai"

// helpers
function makeToolResult(toolName: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "id-1",
		toolName,
		content: [{ type: "text", text }],
		details: undefined,
		isError,
		timestamp: 0,
	}
}

function makeUser() {
	return { role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 0 }
}

function makeAssistant() {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		api: "anthropic" as any,
		provider: "anthropic" as any,
		model: "test",
		stopReason: "stop" as any,
		timestamp: 0,
	}
}

// ── computeCutoff ────────────────────────────────────────────────────────────

describe("computeCutoff", () => {
	const PROTECT_WINDOW = 4
	const MAX_PROTECTED_CHARS = 100

	it("returns 0 when messages fit within protected budget", () => {
		const messages = [makeUser(), makeAssistant(), makeToolResult("bash", "small"), makeUser()]
		expect(computeCutoff(messages as any, PROTECT_WINDOW, MAX_PROTECTED_CHARS)).toBe(0)
	})

	it("returns 0 when array length <= PROTECT_WINDOW", () => {
		const messages = [makeToolResult("bash", "x".repeat(200))]
		expect(computeCutoff(messages as any, PROTECT_WINDOW, MAX_PROTECTED_CHARS)).toBe(0)
	})

	it("cuts at PROTECT_WINDOW boundary when chars are small", () => {
		// 6 messages, PROTECT_WINDOW=4 → cutoff should be 2
		const messages = [
			makeToolResult("bash", "a"),
			makeToolResult("bash", "b"),
			makeUser(),
			makeAssistant(),
			makeToolResult("bash", "c"),
			makeUser(),
		]
		expect(computeCutoff(messages as any, PROTECT_WINDOW, MAX_PROTECTED_CHARS)).toBe(2)
	})

	it("cuts earlier when recent tool results exceed MAX_PROTECTED_CHARS", () => {
		// large output in the last 4 messages exceeds budget → cutoff forced earlier
		const bigOutput = "x".repeat(150) // > MAX_PROTECTED_CHARS=100
		const messages = [
			makeToolResult("bash", "old"),
			makeUser(),
			makeAssistant(),
			makeToolResult("bash", bigOutput), // index 3 — in protect zone, but exceeds budget
			makeUser(),
		]
		// walking back: index 4 (user, 0 chars), index 3 (toolResult, 150 chars → exceeds 100)
		// → cutoff = 4 (message at index 3 pushed out of protected zone)
		expect(computeCutoff(messages as any, PROTECT_WINDOW, MAX_PROTECTED_CHARS)).toBe(4)
	})
})

// ── pruneToolResult ──────────────────────────────────────────────────────────

describe("pruneToolResult", () => {
	const MIN_PRUNE_CHARS = 10

	it("returns a new object (no mutation)", () => {
		const msg = makeToolResult("bash", "x".repeat(20))
		const result = pruneToolResult(msg, MIN_PRUNE_CHARS)
		expect(result).not.toBe(msg)
		expect(msg.content[0]).toHaveProperty("text", "x".repeat(20)) // original unchanged
	})

	it("replaces large text content with placeholder", () => {
		const msg = makeToolResult("bash", "x".repeat(20))
		const result = pruneToolResult(msg, MIN_PRUNE_CHARS)
		expect(result.content[0]).toHaveProperty("type", "text")
		expect((result.content[0] as any).text).toContain("[compacted: bash output")
	})

	it("leaves small text content untouched", () => {
		const msg = makeToolResult("bash", "tiny")
		const result = pruneToolResult(msg, MIN_PRUNE_CHARS)
		expect((result.content[0] as any).text).toBe("tiny")
	})

	it("preserves non-text content blocks unchanged", () => {
		const msg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "id-1",
			toolName: "bash",
			content: [
				{ type: "image", source: { type: "base64", mediaType: "image/png", data: "abc" } } as any,
				{ type: "text", text: "x".repeat(20) },
			],
			details: undefined,
			isError: false,
			timestamp: 0,
		}
		const result = pruneToolResult(msg, MIN_PRUNE_CHARS)
		expect(result.content[0]).toHaveProperty("type", "image") // untouched
		expect((result.content[1] as any).text).toContain("[compacted")
	})

	it("truncates error output to last 2000 chars with header", () => {
		const longError = "e".repeat(5000)
		const msg = makeToolResult("bash", longError, true)
		const result = pruneToolResult(msg, MIN_PRUNE_CHARS)
		const text = (result.content[0] as any).text as string
		expect(text).toContain("[compacted: bash error")
		expect(text).toContain("e".repeat(2000))
		expect(text.length).toBeLessThan(longError.length)
	})

	it("preserves all ToolResultMessage fields", () => {
		const msg = makeToolResult("read", "x".repeat(20))
		const result = pruneToolResult(msg, MIN_PRUNE_CHARS)
		expect(result.toolCallId).toBe(msg.toolCallId)
		expect(result.toolName).toBe(msg.toolName)
		expect(result.isError).toBe(msg.isError)
		expect(result.timestamp).toBe(msg.timestamp)
	})
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- context-compactor
```

Expected: fails with "Cannot find module './context-compactor.js'"

- [ ] **Step 3: Create the implementation**

Create `src/extensions/context-compactor.ts`:

```typescript
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai"
import type { AgentMessage, ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { isSubagent } from "./orchestration/prompt-transformer/prompt-transformer.js"

const PRUNE_THRESHOLD = 35_000
const PROTECT_WINDOW = 30
const MAX_PROTECTED_CHARS = 100_000
const MIN_PRUNE_CHARS = 500

/**
 * Walk backwards through messages to find the cutoff index.
 * Messages at index >= cutoff are kept; messages before cutoff are candidates for pruning.
 *
 * Stops protecting at whichever bound is hit first:
 * - PROTECT_WINDOW messages from the end, OR
 * - Accumulated tool-result chars exceed MAX_PROTECTED_CHARS
 *
 * Returns 0 if everything fits within the protected budget (nothing to prune).
 */
export function computeCutoff(
	messages: AgentMessage[],
	protectWindow: number,
	maxProtectedChars: number,
): number {
	let cutoff = 0
	let protectedChars = 0

	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages.length - i > protectWindow) {
			cutoff = i + 1
			break
		}
		const m = messages[i] as ToolResultMessage
		if (m.role === "toolResult") {
			for (const block of m.content) {
				if (block.type === "text") protectedChars += block.text.length
			}
		}
		if (protectedChars > maxProtectedChars) {
			cutoff = i + 1
			break
		}
	}

	return cutoff
}

/**
 * Return a pruned copy of a ToolResultMessage.
 * - Large text blocks are replaced with a placeholder (preserves all other fields).
 * - Error outputs keep the last 2000 chars so the agent can still read the crash reason.
 * - Non-text content blocks (images, etc.) are left untouched.
 */
export function pruneToolResult(msg: ToolResultMessage, minPruneChars: number): ToolResultMessage {
	return {
		...msg,
		content: msg.content.map((block) => {
			if (block.type !== "text") return block
			if (block.text.length < minPruneChars) return block
			if (msg.isError) {
				const tail = block.text.slice(-2000)
				return {
					...block,
					text: `[compacted: ${msg.toolName} error, ${block.text.length} chars]\n...\n${tail}`,
				}
			}
			return {
				...block,
				text: `[compacted: ${msg.toolName} output, ${block.text.length} chars]`,
			}
		}),
	}
}

export default function contextCompactorExtension(pi: ExtensionAPI) {
	if (isSubagent()) return

	// Closure-scoped: independent per agent instance, safe if multiple are constructed.
	let lastInputTokens = 0

	pi.on("message_end", async (event) => {
		const msg = event.message as AssistantMessage
		if (msg.role !== "assistant") return
		lastInputTokens = msg.usage?.input ?? 0
	})

	pi.on("context", async (event) => {
		if (lastInputTokens < PRUNE_THRESHOLD) return

		const { messages } = event
		const cutoff = computeCutoff(messages, PROTECT_WINDOW, MAX_PROTECTED_CHARS)
		if (cutoff === 0) return

		return {
			messages: messages.map((msg, i) => {
				if (i >= cutoff) return msg
				// Explicit cast required: AgentMessage = Message | CustomAgentMessages union;
				// role check alone does not narrow to ToolResultMessage in TypeScript.
				const m = msg as ToolResultMessage
				if (m.role !== "toolResult") return msg
				return pruneToolResult(m, MIN_PRUNE_CHARS)
			}),
		}
	})
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
pnpm test -- context-compactor
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/extensions/context-compactor.ts src/extensions/context-compactor.test.ts
git commit -m "LLM-1395: add context compactor — prune old tool results mid-session"
```

---

### Task 2: Register in cli.ts

**Files:**
- Modify: `src/cli.ts:17-31` (imports block), `src/cli.ts:183-199` (extensions array)

- [ ] **Step 1: Add the import**

In `src/cli.ts`, after line 24 (`import promptSummaryExtension ...`), add:

```typescript
import contextCompactorExtension from "./extensions/context-compactor.js"
```

- [ ] **Step 2: Add to the extensions array**

In the extensions array (around line 191), add `contextCompactorExtension` after `promptSummaryExtension`:

```typescript
promptSummaryExtension,
contextCompactorExtension,
```

- [ ] **Step 3: Build to verify no type errors**

```bash
pnpm build
```

Expected: exits 0 with no TypeScript errors.

- [ ] **Step 4: Run full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "LLM-1395: register context-compactor extension"
```
