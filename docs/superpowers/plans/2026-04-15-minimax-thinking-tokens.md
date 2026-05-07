# MiniMax Inline Thinking Token Rendering Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse `<thinking>...</thinking>` tags that MiniMax streams inline as raw text and render them as collapsible thinking blocks in the TUI, without modifying pi-ai or the data model.

**Architecture:** MiniMax outputs thinking wrapped in `<thinking>` XML tags inside the plain text stream. Rather than restructuring the data model, we patch pi-coding-agent's `AssistantMessageComponent` to parse those tags from `TextContent` at render time. A TypeScript utility (`inline-thinking-parser.ts`) holds the tested parser logic; an equivalent inline copy lives in the patch. Storage stays as `TextContent` with embedded tags, which means `<thinking>` tags are preserved verbatim on outbound turns — exactly what MiniMax requires for continued performance.

**Tech Stack:** TypeScript, Vitest, pnpm patch (git-format diff applied to pi-coding-agent dist)

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/utils/inline-thinking-parser.ts` | Pure parser: `string → InlinePart[]`. Source of truth for logic and types. |
| Create | `src/utils/inline-thinking-parser.test.ts` | Vitest unit tests for the parser |
| Modify | `patches/@mariozechner__pi-coding-agent.patch` | Extend existing patch to also patch `assistant-message.js` |

The parser logic is duplicated between the TS file (for testability) and the inlined JS in the patch (for runtime). They must stay in sync. The logic is ~40 lines — acceptable duplication.

---

## Task 1: Write failing tests for `parseInlineThinking`

**Files:**
- Create: `src/utils/inline-thinking-parser.test.ts`

- [ ] **Step 1: Create the test file**

```ts
// src/utils/inline-thinking-parser.test.ts
import { describe, expect, it } from "vitest"
import { parseInlineThinking } from "./inline-thinking-parser.js"

describe("parseInlineThinking", () => {
	it("returns single text part when no thinking tags present", () => {
		expect(parseInlineThinking("hello world")).toEqual([
			{ type: "text", content: "hello world" },
		])
	})

	it("returns empty array for empty string", () => {
		expect(parseInlineThinking("")).toEqual([])
	})

	it("parses a complete thinking block", () => {
		expect(parseInlineThinking("<thinking>reasoning here</thinking>actual answer")).toEqual([
			{ type: "thinking", content: "reasoning here", complete: true },
			{ type: "text", content: "actual answer" },
		])
	})

	it("parses text before a complete thinking block", () => {
		expect(parseInlineThinking("prefix<thinking>thought</thinking>suffix")).toEqual([
			{ type: "text", content: "prefix" },
			{ type: "thinking", content: "thought", complete: true },
			{ type: "text", content: "suffix" },
		])
	})

	it("handles in-progress thinking block (no closing tag)", () => {
		expect(parseInlineThinking("<thinking>reasoning in progress")).toEqual([
			{ type: "thinking", content: "reasoning in progress", complete: false },
		])
	})

	it("holds back partial opening tag at end of text", () => {
		expect(parseInlineThinking("some text<thi")).toEqual([
			{ type: "text", content: "some text" },
			{ type: "pending", content: "<thi" },
		])
	})

	it("holds back a single < at end of text", () => {
		expect(parseInlineThinking("some text<")).toEqual([
			{ type: "text", content: "some text" },
			{ type: "pending", content: "<" },
		])
	})

	it("does not hold back < when it cannot be a thinking tag prefix", () => {
		// "<x" cannot be a prefix of "<thinking>", so it's just text
		expect(parseInlineThinking("some text<x")).toEqual([
			{ type: "text", content: "some text<x" },
		])
	})

	it("trims partial closing tag from in-progress thinking content", () => {
		// "</thin" is a prefix of "</thinking>" — trim from content display
		const parts = parseInlineThinking("<thinking>reasoning</thin")
		expect(parts).toEqual([
			{ type: "thinking", content: "reasoning", complete: false },
		])
	})

	it("handles multiple complete thinking blocks", () => {
		expect(parseInlineThinking("<thinking>a</thinking>text<thinking>b</thinking>end")).toEqual([
			{ type: "thinking", content: "a", complete: true },
			{ type: "text", content: "text" },
			{ type: "thinking", content: "b", complete: true },
			{ type: "text", content: "end" },
		])
	})

	it("filters empty parts", () => {
		// No text before or after the thinking block
		expect(parseInlineThinking("<thinking>thought</thinking>")).toEqual([
			{ type: "thinking", content: "thought", complete: true },
		])
	})
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/ibar/castai/src/kimchi-dev
pnpm test -- --reporter=verbose src/utils/inline-thinking-parser.test.ts
```

Expected: `Error: Cannot find module './inline-thinking-parser.js'`

---

## Task 2: Implement `parseInlineThinking`

**Files:**
- Create: `src/utils/inline-thinking-parser.ts`

- [ ] **Step 1: Create the implementation**

```ts
// src/utils/inline-thinking-parser.ts

export type TextPart = { type: "text"; content: string }
export type ThinkingPart = { type: "thinking"; content: string; complete: boolean }
export type PendingPart = { type: "pending"; content: string }
export type InlinePart = TextPart | ThinkingPart | PendingPart

const OPEN = "<thinking>"
const CLOSE = "</thinking>"

/**
 * Parse a text string that may contain inline <thinking>...</thinking> tags
 * (as produced by MiniMax-M2) into a sequence of typed parts.
 *
 * - "text" parts: regular content, render as markdown
 * - "thinking" parts: thinking block content; complete=false means still streaming
 * - "pending" parts: potential start of a tag at the very end of the text;
 *   do NOT render these — they'll resolve on the next chunk
 *
 * Designed to be called on every streaming chunk (the full accumulated text so far).
 */
export function parseInlineThinking(text: string): InlinePart[] {
	if (!text) return []

	const parts: InlinePart[] = []

	// Hold back any partial <thinking> prefix at the very end to prevent flicker.
	const pendingLen = trailingPartial(text, OPEN)
	const safe = pendingLen > 0 ? text.slice(0, -pendingLen) : text
	const pending = pendingLen > 0 ? text.slice(-pendingLen) : ""

	let pos = 0
	while (pos < safe.length) {
		const openIdx = safe.indexOf(OPEN, pos)
		if (openIdx === -1) {
			push(parts, { type: "text", content: safe.slice(pos) })
			break
		}
		if (openIdx > pos) {
			push(parts, { type: "text", content: safe.slice(pos, openIdx) })
		}
		const afterOpen = openIdx + OPEN.length
		const closeIdx = safe.indexOf(CLOSE, afterOpen)
		if (closeIdx === -1) {
			// In-progress thinking — trim any partial </thinking> from end
			let content = safe.slice(afterOpen)
			const partialClose = trailingPartial(content, CLOSE)
			if (partialClose > 0) content = content.slice(0, -partialClose)
			push(parts, { type: "thinking", content, complete: false })
			break
		}
		push(parts, { type: "thinking", content: safe.slice(afterOpen, closeIdx), complete: true })
		pos = closeIdx + CLOSE.length
	}

	if (pending) parts.push({ type: "pending", content: pending })

	return parts
}

/** Push part only if it has non-empty content. */
function push(parts: InlinePart[], part: InlinePart): void {
	if (part.content.length > 0) parts.push(part)
}

/**
 * Returns the number of characters at the end of `text` that form a
 * prefix of `tag` (length 1 to tag.length-1). Returns 0 if none.
 *
 * Example: trailingPartial("hello <thi", "<thinking>") === 4
 */
function trailingPartial(text: string, tag: string): number {
	for (let len = Math.min(tag.length - 1, text.length); len >= 1; len--) {
		if (text.endsWith(tag.slice(0, len))) return len
	}
	return 0
}
```

- [ ] **Step 2: Run the tests**

```bash
pnpm test -- --reporter=verbose src/utils/inline-thinking-parser.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/utils/inline-thinking-parser.ts src/utils/inline-thinking-parser.test.ts
git commit -m "NOJIRA: Add inline thinking tag parser utility"
```

---

## Task 3: Patch `assistant-message.js` to render inline thinking tags

**Files:**
- Modify: `patches/@mariozechner__pi-coding-agent.patch`

The patch workflow creates a temporary editable copy of the package, you make changes, then commit them back as a diff.

- [ ] **Step 1: Create a pnpm patch working copy**

```bash
cd /Users/ibar/castai/src/kimchi-dev
pnpm patch @mariozechner/pi-coding-agent@0.65.2
```

Expected output includes a path like:
```
You can now edit the package at:
  /private/var/folders/.../pi-coding-agent@0.65.2
```

Copy that path — you'll need it for Step 4.

- [ ] **Step 2: Edit the patched file**

Open the file at `<patch-path>/dist/modes/interactive/components/assistant-message.js`.

Replace the entire file content with:

```js
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
/**
 * Parse inline <thinking>...</thinking> tags from a text string.
 * Returns an array of parts: "text" | "thinking" | "pending".
 * "pending" parts are potential tag prefixes at the end — do not render them.
 */
function parseInlineThinking(text) {
    if (!text) return [];
    const OPEN = "<thinking>";
    const CLOSE = "</thinking>";
    const parts = [];
    function trailingPartial(str, tag) {
        for (let len = Math.min(tag.length - 1, str.length); len >= 1; len--) {
            if (str.endsWith(tag.slice(0, len))) return len;
        }
        return 0;
    }
    function push(part) {
        if (part.content.length > 0) parts.push(part);
    }
    const pendingLen = trailingPartial(text, OPEN);
    const safe = pendingLen > 0 ? text.slice(0, -pendingLen) : text;
    const pending = pendingLen > 0 ? text.slice(-pendingLen) : "";
    let pos = 0;
    while (pos < safe.length) {
        const openIdx = safe.indexOf(OPEN, pos);
        if (openIdx === -1) {
            push({ type: "text", content: safe.slice(pos) });
            break;
        }
        if (openIdx > pos) {
            push({ type: "text", content: safe.slice(pos, openIdx) });
        }
        const afterOpen = openIdx + OPEN.length;
        const closeIdx = safe.indexOf(CLOSE, afterOpen);
        if (closeIdx === -1) {
            let content = safe.slice(afterOpen);
            const partialClose = trailingPartial(content, CLOSE);
            if (partialClose > 0) content = content.slice(0, -partialClose);
            push({ type: "thinking", content, complete: false });
            break;
        }
        push({ type: "thinking", content: safe.slice(afterOpen, closeIdx), complete: true });
        pos = closeIdx + CLOSE.length;
    }
    if (pending) parts.push({ type: "pending", content: pending });
    return parts;
}
/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
    contentContainer;
    hideThinkingBlock;
    markdownTheme;
    hiddenThinkingLabel;
    lastMessage;
    constructor(message, hideThinkingBlock = false, markdownTheme = getMarkdownTheme(), hiddenThinkingLabel = "Thinking...") {
        super();
        this.hideThinkingBlock = hideThinkingBlock;
        this.markdownTheme = markdownTheme;
        this.hiddenThinkingLabel = hiddenThinkingLabel;
        // Container for text/thinking content
        this.contentContainer = new Container();
        this.addChild(this.contentContainer);
        if (message) {
            this.updateContent(message);
        }
    }
    invalidate() {
        super.invalidate();
        if (this.lastMessage) {
            this.updateContent(this.lastMessage);
        }
    }
    setHideThinkingBlock(hide) {
        this.hideThinkingBlock = hide;
        if (this.lastMessage) {
            this.updateContent(this.lastMessage);
        }
    }
    setHiddenThinkingLabel(label) {
        this.hiddenThinkingLabel = label;
        if (this.lastMessage) {
            this.updateContent(this.lastMessage);
        }
    }
    updateContent(message) {
        this.lastMessage = message;
        // Clear content container
        this.contentContainer.clear();
        const hasVisibleContent = message.content.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));
        if (hasVisibleContent) {
            this.contentContainer.addChild(new Spacer(1));
        }
        // Render content in order
        for (let i = 0; i < message.content.length; i++) {
            const content = message.content[i];
            if (content.type === "text" && content.text.trim()) {
                // Parse inline <thinking> tags before rendering
                const inlineParts = parseInlineThinking(content.text);
                for (const part of inlineParts) {
                    if (part.type === "text" && part.content.trim()) {
                        this.contentContainer.addChild(new Markdown(part.content.trim(), 1, 0, this.markdownTheme));
                    }
                    else if (part.type === "thinking" && part.content.trim()) {
                        if (this.hideThinkingBlock) {
                            this.contentContainer.addChild(new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 1, 0));
                        }
                        else {
                            this.contentContainer.addChild(new Markdown(part.content.trim(), 1, 0, this.markdownTheme, {
                                color: (text) => theme.fg("thinkingText", text),
                                italic: true,
                            }));
                        }
                    }
                    // "pending" parts: potential partial tag — not rendered
                }
            }
            else if (content.type === "thinking" && content.thinking.trim()) {
                // Add spacing only when another visible assistant content block follows.
                // This avoids a superfluous blank line before separately-rendered tool execution blocks.
                const hasVisibleContentAfter = message.content
                    .slice(i + 1)
                    .some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));
                if (this.hideThinkingBlock) {
                    // Show static thinking label when hidden
                    this.contentContainer.addChild(new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 1, 0));
                    if (hasVisibleContentAfter) {
                        this.contentContainer.addChild(new Spacer(1));
                    }
                }
                else {
                    // Thinking traces in thinkingText color, italic
                    this.contentContainer.addChild(new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
                        color: (text) => theme.fg("thinkingText", text),
                        italic: true,
                    }));
                    if (hasVisibleContentAfter) {
                        this.contentContainer.addChild(new Spacer(1));
                    }
                }
            }
        }
        // Check if aborted - show after partial content
        // But only if there are no tool calls (tool execution components will show the error)
        const hasToolCalls = message.content.some((c) => c.type === "toolCall");
        if (!hasToolCalls) {
            if (message.stopReason === "aborted") {
                const abortMessage = message.errorMessage && message.errorMessage !== "Request was aborted"
                    ? message.errorMessage
                    : "Operation aborted";
                if (hasVisibleContent) {
                    this.contentContainer.addChild(new Spacer(1));
                }
                else {
                    this.contentContainer.addChild(new Spacer(1));
                }
                this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
            }
            else if (message.stopReason === "error") {
                const errorMsg = message.errorMessage || "Unknown error";
                this.contentContainer.addChild(new Spacer(1));
                this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
            }
        }
    }
}
//# sourceMappingURL=assistant-message.js.map
```

- [ ] **Step 3: Commit the patch**

```bash
pnpm patch-commit <path-from-step-1>
```

Expected: `patches/@mariozechner__pi-coding-agent.patch` is updated with the new diff hunk.

- [ ] **Step 4: Reinstall to apply the patch**

```bash
pnpm install
```

Expected: No errors. The patched file is now active in node_modules.

- [ ] **Step 5: Run the full test suite**

```bash
pnpm test
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add patches/@mariozechner__pi-coding-agent.patch
git commit -m "NOJIRA: Render MiniMax inline thinking tags as collapsible blocks"
```

---

## Task 4: Manual verification

- [ ] **Step 1: Build and run with minimax-m2.7**

```bash
pnpm dev
```

Switch to `minimax-m2.7` model and send a prompt that triggers reasoning (e.g., "What is 17 × 23? Think step by step.").

- [ ] **Step 2: Verify thinking block rendering**

Expected behavior:
- While the model streams, `<thinking>` content appears in italic gray (themed as `thinkingText`)
- After `</thinking>`, the actual answer appears in normal text color
- Partial `<thinking>` prefix tokens (`<thi`, `<think`, etc.) do NOT appear as visible text — they appear only once the full tag is confirmed
- Toggling thinking hide/show (existing keybinding) works for inline-parsed thinking too

- [ ] **Step 3: Verify no regression on native thinking models**

Switch to a model that produces native `ThinkingContent` blocks (e.g., Claude or Kimi). Verify thinking blocks still render correctly via the `else if (content.type === "thinking")` path, which is unchanged.

- [ ] **Step 4: Verify outbound tag preservation**

In the same session, send a follow-up message. Confirm the model continues to reason correctly — the `<thinking>` tags are preserved in the stored `TextContent` and sent back verbatim on the next turn.

---

## Self-Review Notes

**Spec coverage:**
- ✅ Real-time streaming display — `updateContent` is called on every `text_delta`, renderer re-parses the accumulated text, partial tags held back via `pending`
- ✅ Collapsible thinking blocks — uses existing `hideThinkingBlock` / `hiddenThinkingLabel` mechanism
- ✅ No UI duplication — raw `<thinking>` text is replaced by styled thinking block, not shown alongside it
- ✅ Tags preserved for outbound — `TextContent` is stored as-is with embedded tags; no data model changes
- ✅ Native `ThinkingContent` rendering — unchanged `else if` branch still handles it

**Tradeoffs documented:**
- `parseInlineThinking` logic is duplicated between `src/utils/inline-thinking-parser.ts` (TypeScript, tested) and the inlined JS in the patch. Keep them in sync when changing parser logic.
- No model-specific gating: the parser runs for ALL `TextContent`. This is intentional — the feature is harmless for models that don't emit `<thinking>` tags, and makes the behavior generic for any future interleaved-thinking model.
