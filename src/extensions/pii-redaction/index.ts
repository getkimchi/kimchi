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
 * Redaction is disabled by default. It is governed by the resources system:
 *   - /resources toggle or settings.json resources override
 *   - KIMCHI_ENABLE_RESOURCES=extensions.pii-redaction env (transient)
 *   - the org policy's kimchiResources entry (ON/OFF defaults, FORCE_* locks)
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { isRedactionEnabled } from "./config.js"
import { emitRedactionFacts, type RedactionSurface } from "./redaction-events.js"
import {
	emptyRedactionReport,
	mergeReports,
	type RedactionMeasurement,
	redactObjectStringsMeasured,
} from "./redactor.js"

/** Cache of redacted messages, keyed by original message reference. */
const redactionCache = new WeakMap<object, object>()
/**
 * In-flight redactions, keyed like the cache — checked and populated
 * synchronously before the first await, so two concurrent cache-miss paths
 * for the same message reference (e.g. one request payload carrying the
 * same object twice) await one redaction and emit its facts exactly once.
 */
const redactionInFlight = new Map<object, Promise<RedactionMeasurement<object>>>()

/** Map a request-message role to the redaction surface it belongs to. */
function surfaceForRole(role: unknown): RedactionSurface | undefined {
	if (role === "user") return "user_input"
	if (role === "assistant") return "assistant_message"
	if (role === "tool") return "tool_result"
	return undefined
}

const piiRedactionExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	// 1. Redact assistant messages before they are stored.
	pi.on("message_end", async (event: unknown) => {
		// Non-throwing gate: a broken settings block must not reject the hook
		// (the extension runner discards rejected results — unredacted storage).
		if (!isRedactionEnabled()) return

		const evt = event as Record<string, unknown> | null
		if (!evt || typeof evt !== "object") return

		const message = evt.message
		if (!message || typeof message !== "object") return

		// Redact the message content (deep-walk all strings).
		const { redacted, report } = await redactObjectStringsMeasured(message)
		// Emit redaction facts labelled by message role. message_end fires for
		// user and assistant messages (and system messages — redacted for
		// storage hygiene but never emitted, since they are not user data).
		// The user case is where most user_input facts originate: message_end
		// runs before before_provider_request sees the message, so the request
		// hook usually re-scans already-redacted text and reports nothing.
		const surface = surfaceForRole((message as { role?: string }).role)
		if (surface) emitRedactionFacts(pi, surface, report)
		// biome-ignore lint/suspicious/noExplicitAny: MessageEndEventResult.message type is AgentMessage but we operate on unknown
		return { message: redacted } as any
	})

	// 2. Redact tool result content before it is persisted.
	pi.on("tool_result", async (event: unknown) => {
		// Non-throwing gate: a broken settings block must not reject the hook
		// (the extension runner discards rejected results — unredacted storage).
		if (!isRedactionEnabled()) return

		const evt = event as Record<string, unknown> | null
		if (!evt || typeof evt !== "object") return

		const content = evt.content
		if (!Array.isArray(content)) return

		const aggregate = emptyRedactionReport()
		const redactedContent = await Promise.all(
			content.map(async (block: unknown) => {
				if (block === null || typeof block !== "object") return block
				const b = block as Record<string, unknown>
				if (b.type === "text" && typeof b.text === "string") {
					const { redacted, report } = await redactObjectStringsMeasured(b.text)
					mergeReports(aggregate, report)
					return { ...b, text: redacted }
				}
				return block
			}),
		)
		emitRedactionFacts(pi, "tool_result", aggregate)

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

		// Non-throwing gate: a broken settings block must not reject the hook
		// (the extension runner discards rejected results — unredacted storage).
		if (!isRedactionEnabled()) return

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
				// Cache miss. Synchronously register the in-flight promise before
				// the first await, so every concurrent miss for this same object
				// (a payload carrying the reference twice) shares one redaction —
				// exactly one emission per message, not one per occurrence.
				let inFlight = redactionInFlight.get(msg)
				const isEmitter = !inFlight
				if (!inFlight) {
					inFlight = redactObjectStringsMeasured(msg) as Promise<RedactionMeasurement<object>>
					redactionInFlight.set(msg, inFlight)
					inFlight.finally(() => redactionInFlight.delete(msg)).catch(() => {})
				}
				const { redacted: redactedMsg, report } = await inFlight
				if (isEmitter) {
					redactionCache.set(msg, redactedMsg as object)
					// Facts are labelled by the message role — a cache-miss
					// assistant-message in restored history must not inflate the
					// user_input dimension.
					const surface = surfaceForRole(message.role)
					if (surface) emitRedactionFacts(pi, surface, report)
				}
				return redactedMsg
			}),
		)

		payload.messages = redacted
		return payload
	})
}

export default piiRedactionExtension
