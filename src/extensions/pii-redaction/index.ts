/**
 * PII redaction extension.
 *
 * Registers two hooks:
 *
 * 1. `before_provider_request` — scrubs PII/secrets from outgoing
 *    provider-request messages using @bulkhead-ai/core. This catches
 *    secrets in user prompts, assistant text, tool-call arguments, and
 *    tool-result content before they reach the LLM.
 *
 * 2. `tool_result` — redacts PII/secrets from tool result content before
 *    it is persisted to the session file. This ensures the on-disk
 *    session transcript does not contain secrets that were returned by
 *    tools (e.g. a bash command that prints an API key).
 *
 * Contract: the `before_provider_request` event is emitted by pi-mono's
 * ExtensionRunner.emitBeforeProviderRequest. Handlers receive `event.payload`
 * with `payload.messages` as pi-ai `Message[]` (the output of `convertToLlm`).
 * Returning a modified payload replaces it. See orphan-tool-result-sanitizer.ts
 * for the same pattern.
 *
 * Redaction is enabled by default. Disable via:
 *   - KIMCHI_REDACTION_ENABLED=0 env var
 *   - config.json { "redaction": { "enabled": false } }
 *
 * The handler is async — @bulkhead-ai/core's engine.scan() returns a Promise.
 * pi-mono's ExtensionRunner awaits handler return values when they are
 * Promises, so the async redaction completes before the request is sent.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { getRedactionConfig } from "./config.js"
import { redactObjectStrings, redactText } from "./redactor.js"

const piiRedactionExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	pi.on("before_provider_request", async (event: unknown) => {
		const payload = (event as Record<string, unknown> | null)?.payload as Record<string, unknown> | null
		if (!payload || typeof payload !== "object") return

		const messages = payload.messages
		if (!Array.isArray(messages)) return

		// Redaction config is cached at startup — avoids sync disk I/O in the hot path.
		const config = getRedactionConfig()
		if (!config.enabled) return

		// Redact PII/secrets from ALL string values in the messages array.
		// This catches secrets in user prompts, assistant text, tool-call
		// arguments, and tool-result content. Structural strings (role, type,
		// toolCallId) pass through unchanged — they don't match PII patterns.
		// redactObjectStrings returns a new structure; input is never mutated.
		const redacted = await redactObjectStrings(messages)
		payload.messages = redacted
		return payload
	})

	// Redact tool result content before it is persisted to the session file.
	// This ensures secrets returned by tools (e.g. a bash command that prints
	// an API key) are scrubbed from the on-disk session transcript.
	pi.on("tool_result", async (event: unknown) => {
		const config = getRedactionConfig()
		if (!config.enabled) return

		const evt = event as Record<string, unknown> | null
		if (!evt || typeof evt !== "object") return

		const content = evt.content
		if (!Array.isArray(content)) return

		// Redact all text content blocks in the tool result.
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
}

export default piiRedactionExtension
