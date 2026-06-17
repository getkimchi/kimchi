/**
 * Strips OpenAI-style reasoning from assistant messages before they are sent
 * to the model API, so reasoning content is never echoed back to the server.
 *
 * OpenAI-compatible providers (llama.cpp, gpt-oss, deepseek-reasoner, MiniMax,
 * Moonshot, etc.) emit reasoning in TWO redundant places on the in-memory
 * AssistantMessage:
 *
 *   1. As top-level fields on the message:
 *        - reasoning_content (string)
 *        - reasoning (string) — alt provider field name
 *        - reasoning_text (string) — alt provider field name
 *        - reasoning_details (array) — structured payloads, e.g.
 *          `{ type: "reasoning.encrypted", id, data }` from gpt-oss
 *
 *   2. As ThinkingContent blocks inside `content` whose `thinkingSignature`
 *      equals one of the field names above. The upstream openai-completions.js
 *      `convertMessages` re-builds the top-level fields from these blocks on
 *      every outgoing request, so deleting only the top-level fields is not
 *      enough — the content blocks must also be stripped.
 *
 * `reasoning_details` is similarly rebuilt from tool calls' `thoughtSignature`
 * in `convertMessages`, so tool-call `thoughtSignature` must be stripped too.
 *
 * Scope (intentionally narrow):
 *   - Strips ONLY the OpenAI-style reasoning fields above. Detection of an
 *     OpenAI-style ThinkingContent block is `thinkingSignature in
 *     REASONING_FIELDS`. Anthropic/Bedrock extended-thinking blocks use an
 *     opaque encrypted signature and are NOT matched, so they pass through
 *     untouched.
 *   - Does NOT touch the thinking PROSE in native ThinkingContent blocks
 *     (e.g. Anthropic extended thinking). Stripping those would break
 *     tool-use reasoning continuity because the signature must be preserved.
 *   - Does NOT touch text-tag thinking (`<think>…</think>`, `<mm:think>…</mm:think>`)
 *     inside text blocks — display-side redaction is handled by hide-thinking.ts.
 *
 * Behaviour controlled by `truncateReasoning` in settings.json:
 *   - true (default): strip the OpenAI-style reasoning from every LLM call
 *   - false: opt out — leave reasoning in the outgoing payload
 *
 * The strip happens in the `context` event hook (non-destructive — runner.js
 * deep-clones the messages before passing them in). Session JSONL on disk is
 * untouched, so `/tree`, `/compact`, fork, and resume still see the original.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isSubagent } from "./prompt-construction/prompt-enrichment.js"

// ---------------------------------------------------------------------------
// Field list — keep in sync with upstream openai-completions.js reasoning writes
// (reasoningFields at openai-completions.js:239 and reasoning_details at :721).
// Add a new entry here if a new provider writes a reasoning field under a
// different name.
// ---------------------------------------------------------------------------
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text", "reasoning_details"] as const

const REASONING_FIELD_SET: ReadonlySet<string> = new Set(REASONING_FIELDS)

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getSettingsPath(): string | undefined {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return undefined
	return resolve(agentDir, "settings.json")
}

/** Override for tests — bypasses settings.json when set. */
let truncateReasoningOverride: boolean | undefined

function readTruncateReasoningSetting(): boolean {
	if (truncateReasoningOverride !== undefined) return truncateReasoningOverride
	const settingsPath = getSettingsPath()
	if (!settingsPath) return true
	try {
		const raw = readFileSync(settingsPath, "utf-8")
		const parsed = JSON.parse(raw)
		if (parsed && typeof parsed === "object" && "truncateReasoning" in parsed) {
			return Boolean((parsed as { truncateReasoning: unknown }).truncateReasoning)
		}
		return true
	} catch {
		// Malformed settings.json — fall back to default (enabled).
		return true
	}
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function _setTruncateReasoning(value: boolean | undefined): void {
	truncateReasoningOverride = value
}

export function _resetState(): void {
	truncateReasoningOverride = undefined
}

// ---------------------------------------------------------------------------
// Strip
// ---------------------------------------------------------------------------

interface MutableAssistantMessage extends AssistantMessage {
	content: AssistantMessage["content"]
	[key: string]: unknown
}

/**
 * Strip OpenAI-style reasoning from an assistant message in place.
 *
 * Three sources must all be cleared, otherwise the upstream
 * openai-completions.js `convertMessages` will rebuild the top-level fields
 * on the outgoing payload from the content blocks:
 *
 *   1. Top-level fields (reasoning_content, reasoning, reasoning_text,
 *      reasoning_details).
 *   2. ThinkingContent blocks whose `thinkingSignature` is one of the
 *      REASONING_FIELDS — these are the source the upstream reads to
 *      re-populate the top-level field on outgoing.
 *   3. Tool-call `thoughtSignature` — the upstream reads this to populate
 *      `reasoning_details` on outgoing.
 *
 * Returns true if anything changed.
 */
function stripReasoning(msg: AssistantMessage): boolean {
	const mutable = msg as MutableAssistantMessage
	let changed = false

	// 1. Top-level fields.
	for (const field of REASONING_FIELDS) {
		if (field in mutable) {
			delete mutable[field]
			changed = true
		}
	}

	// 2 & 3. Walk content blocks once.
	if (Array.isArray(mutable.content)) {
		const before = mutable.content
		const filtered: typeof before = []
		for (const block of before) {
			if (block.type === "thinking") {
				// Drop thinking blocks whose signature is an OpenAI-style field
				// name. Anthropic-style blocks have an opaque encrypted signature
				// that does NOT match any REASONING_FIELDS entry, so they pass
				// through untouched.
				if (block.thinkingSignature && REASONING_FIELD_SET.has(block.thinkingSignature)) {
					changed = true
					continue
				}
			} else if (block.type === "toolCall") {
				// Drop thoughtSignature from tool calls so the upstream cannot
				// rebuild `reasoning_details` from it on outgoing.
				if (block.thoughtSignature) {
					const tc = block as { thoughtSignature?: string }
					tc.thoughtSignature = undefined
					changed = true
				}
			}
			filtered.push(block)
		}
		if (filtered.length !== before.length) {
			mutable.content = filtered
		}
	}

	return changed
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function truncateReasoningExtension(pi: ExtensionAPI): void {
	if (isSubagent()) return

	pi.on("context", (event) => {
		if (!readTruncateReasoningSetting()) return

		let modified = false
		const messages = event.messages.map((msg) => {
			if (msg.role !== "assistant") return msg
			if (stripReasoning(msg as AssistantMessage)) {
				modified = true
				return msg
			}
			return msg
		})

		if (modified) return { messages }
	})
}
