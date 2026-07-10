/**
 * PII redaction extension.
 *
 * Uses three hooks to scrub PII/secrets from the message pipeline with
 * minimal per-request overhead:
 *
 * 1. `message_end` — redacts assistant messages before they are stored.
 *    One-time cost per message; the stored message is already clean.
 *
 * 2. `tool_result` — redacts tool result content before it is persisted.
 *    One-time cost per tool call; the stored result is already clean.
 *
 * 3. `before_provider_request` — redacts user messages (the only un-redacted
 *    type) before the LLM request. Uses a WeakMap cache keyed by message
 *    reference identity so previously-redacted messages are O(1) lookups.
 *    Only new user messages (cache misses) incur scanning cost.
 *
 * This design means:
 * - The session file is scrubbed (assistant + tool results stored redacted)
 * - Per-request cost is O(new messages) not O(total messages)
 * - No memory doubling — the WeakMap holds one redacted reference per message
 *   and is GC'd when the session manager drops the original
 *
 * Redaction is disabled by default. Enable via:
 *   - KIMCHI_REDACTION_ENABLED=1 env var
 *   - config.json { "redaction": { "enabled": true } }
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { getRedactionConfig } from "./config.js"
import { redactObjectStrings, redactText } from "./redactor.js"

/** Cache of redacted messages, keyed by original message reference. */
const redactionCache = new WeakMap<object, object>()

const piiRedactionExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	// 1. Redact assistant messages before they are stored.
	pi.on("message_end", async (event: unknown) => {
		const config = getRedactionConfig()
		if (!config.enabled) return

		const evt = event as Record<string, unknown> | null
		if (!evt || typeof evt !== "object") return

		const message = evt.message
		if (!message || typeof message !== "object") return

		// Redact the message content (deep-walk all strings).
		const redacted = await redactObjectStrings(message)
		// biome-ignore lint/suspicious/noExplicitAny: MessageEndEventResult.message type is AgentMessage but we operate on unknown
		return { message: redacted } as any
	})

	// 2. Redact tool result content before it is persisted.
	pi.on("tool_result", async (event: unknown) => {
		const config = getRedactionConfig()
		if (!config.enabled) return

		const evt = event as Record<string, unknown> | null
		if (!evt || typeof evt !== "object") return

		const content = evt.content
		if (!Array.isArray(content)) return

		const redactedContent = await Promise.all(
			content.map(async (block: unknown) => {
				if (block === null || typeof block !== "object") return block
				const b = block as Record<string, unknown>
				if (b.type === "text" && typeof b.text === "string") {
					return { ...b, text: await redactText(b.text) }
				}
				return block
			}),
		)

		// biome-ignore lint/suspicious/noExplicitAny: ToolResultEventResult.content type is (TextContent | ImageContent)[] but we operate on unknown
		return { content: redactedContent } as any
	})

	// 3. Redact user messages before the LLM request, using a cache so
	//    previously-redacted messages are not re-scanned.
	pi.on("before_provider_request", async (event: unknown) => {
		const payload = (event as Record<string, unknown> | null)?.payload as Record<string, unknown> | null
		if (!payload || typeof payload !== "object") return

		const messages = payload.messages
		if (!Array.isArray(messages)) return

		const config = getRedactionConfig()
		if (!config.enabled) return

		// Walk messages: system messages pass through unchanged, non-system
		// messages are redacted (or fetched from cache if already redacted).
		const redacted = await Promise.all(
			messages.map(async (msg) => {
				if (msg === null || typeof msg !== "object") return msg
				const message = msg as Record<string, unknown>
				// Skip system messages — they contain structural identifiers.
				if (message.role === "system") return msg
				// Cache hit — return previously redacted version.
				const cached = redactionCache.get(msg)
				if (cached) return cached
				// Cache miss — redact and cache the result.
				const redactedMsg = await redactObjectStrings(msg)
				redactionCache.set(msg, redactedMsg as object)
				return redactedMsg
			}),
		)

		payload.messages = redacted
		return payload
	})
}

export default piiRedactionExtension
