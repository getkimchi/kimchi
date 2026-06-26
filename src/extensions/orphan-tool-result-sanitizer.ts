/**
 * Defensive orphaned toolResult sanitizer.
 *
 * Guarantees that Kimchi never sends a `toolResult` message to any model
 * provider unless the corresponding assistant `toolCall` is also present in
 * the outgoing request's message history.
 *
 * Why this exists: a compaction boundary (or any history-rewriting operation)
 * can drop an assistant toolCall whose matching toolResult is appended later.
 * The orphaned toolResult then sits latent in the rebuilt context — a
 * permissive provider (e.g. kimi-k2.6) continues, but switching to a stricter
 * provider (e.g. Anthropic) fails hard because Anthropic requires every
 * `tool_result` to correspond to a `tool_use` in the preceding assistant
 * message. See session 019edacc (orphaned `functions.complete_ferment:169`).
 *
 * This is the safety-net: it is provider-agnostic, runs for every provider,
 * and drops orphaned toolResults silently (debug log only, no user-facing
 * notification) right before the provider call. Root-cause prevention at the
 * compaction boundary and persisted-history repair-on-load live in later
 * phases of the same ferment; this hook is the last line of defense.
 *
 * Contract: the `before_provider_request` event is emitted by pi-mono's
 * ExtensionRunner.emitBeforeProviderRequest (core/extensions/runner.js) which
 * threads `event.payload` through every handler and replaces it with any
 * non-undefined return value. `payload.messages` at this stage are pi-ai
 * `Message[]` (the output of `convertToLlm`): assistant messages carry
 * `toolCall` content blocks with an `id`; toolResult messages carry a
 * `toolCallId`. A toolResult is orphaned iff its `toolCallId` is not present
 * as any assistant toolCall block `id` in the messages array.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent"

/** A pi-ai toolResult message (the relevant subset). */
interface ToolResultMessage {
	role: "toolResult"
	toolCallId: string
	toolName: string
	content: unknown[]
	isError: boolean
}

/** Any message-shaped object the sanitizer may encounter. */
type AnyMessage = { role?: string; content?: unknown; toolCallId?: string }

/**
 * Return the list of toolResult `toolCallId`s that have NO matching assistant
 * `toolCall` block (by `id`) anywhere in `messages`.
 *
 * Pure, total, never throws: unknown shapes are skipped defensively. The empty
 * result means the message array is well-formed (no orphans).
 *
 * Shared by the sanitizer (phase 1), the compaction-timing guard (phase 2),
 * and the JSONL repair-on-load hook (phase 3) — do not duplicate this logic.
 */
export function findOrphanedToolResults(messages: ReadonlyArray<unknown>): string[] {
	const callIds = new Set<string>()

	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue
		const msg = raw as AnyMessage
		if (msg.role !== "assistant") continue
		const content = msg.content
		if (!Array.isArray(content)) continue
		for (const block of content) {
			if (!block || typeof block !== "object") continue
			const b = block as { type?: string; id?: unknown }
			if (b.type === "toolCall" && typeof b.id === "string") {
				callIds.add(b.id)
			}
		}
	}

	const orphaned: string[] = []
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue
		const msg = raw as AnyMessage
		if (msg.role !== "toolResult") continue
		if (typeof msg.toolCallId !== "string") continue
		if (!callIds.has(msg.toolCallId)) {
			orphaned.push(msg.toolCallId)
		}
	}

	return orphaned
}

/**
 * Extension factory: registers a `before_provider_request` handler that drops
 * orphaned toolResult messages from the outgoing provider request payload.
 *
 * Drop-silent: emits a debug-level log line only (no user-facing `ui.notify`),
 * per the ferment's chosen repair behavior. Provider-agnostic: runs for every
 * provider so the invariant holds regardless of provider strictness.
 *
 * Registered as a direct `ExtensionFactory` (like `modelGuardExtension`), so the
 * harness calls `orphanToolResultSanitizerExtension(pi)` directly.
 */
const orphanToolResultSanitizerExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	pi.on("before_provider_request", (event: unknown) => {
		const payload = (event as Record<string, unknown> | null)?.payload as Record<string, unknown> | null
		if (!payload || typeof payload !== "object") return

		const messages = payload.messages
		if (!Array.isArray(messages)) return

		const orphanIds = findOrphanedToolResults(messages)
		if (orphanIds.length === 0) return

		const orphanSet = new Set(orphanIds)
		const filtered = messages.filter((m: unknown) => {
			if (!m || typeof m !== "object") return true
			const msg = m as ToolResultMessage
			if (msg.role !== "toolResult") return true
			return !orphanSet.has(msg.toolCallId)
		})

		payload.messages = filtered
		try {
			console.debug?.(`[orphan-sanitizer] dropped ${orphanIds.length} orphaned toolResult(s): ${orphanIds.join(", ")}`)
		} catch {
			// console.debug may be undefined in some environments — never throw.
		}
		return payload
	})
}

export default orphanToolResultSanitizerExtension
