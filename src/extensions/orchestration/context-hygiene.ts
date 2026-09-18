/**
 * Context-boundary hygiene transforms for the orchestrator's message list,
 * applied in the `context` handler chain before each LLM call:
 *
 *   1. `stripUiOnlyMessages` — removes display-only custom messages that were
 *      pushed into agent state but must never reach the LLM.
 *   2. `tagSelfEchoes` — annotates user-role messages that are a verbatim
 *      echo of the previous assistant message, so the model doesn't
 *      rationalize the echo as user approval (consent boundary).
 *   3. `brandUnmarkedSteers` — wraps any unbranded custom message in
 *      `<system-reminder>` tags so harness-injected content is always
 *      distinguishable from user-authored text.
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import { isHarnessSteer, markHarnessSteer } from "../steer-marker.js"

/**
 * Message-array shape passed through `context` events. Derived from
 * `ContextEvent` because `AgentMessage` lives in `@earendil-works/pi-agent-core`,
 * which is only a transitive dep — importing it directly works under npm's
 * flat install but breaks under pnpm's strict resolution (and thus CI).
 */
export type OrchestratorMessages = ContextEvent["messages"]

/** Custom types that are display-only UI markers and must never reach the LLM. */
export const UI_ONLY_CUSTOM_TYPES: ReadonlySet<string> = Object.freeze(
	new Set([
		"prompt-summary",
		"curator-notification",
		"ferment_breadcrumb",
		"ferment_worktree_warning",
		"ferment_ack",
		"ferment_request",
		"ferment_oneshot_failed",
	]),
)

function isCustomMessage(
	m: OrchestratorMessages[number],
): m is Extract<OrchestratorMessages[number], { role: "custom" }> {
	return m.role === "custom"
}

/** True when the message's customType is a display-only UI marker. */
function isUiOnlyCustomType(m: OrchestratorMessages[number]): boolean {
	return UI_ONLY_CUSTOM_TYPES.has((m as { customType?: string }).customType ?? "")
}

function replaceMessageContent(m: OrchestratorMessages[number], text: string): OrchestratorMessages[number] {
	if (!("content" in m)) return m
	if (typeof m.content === "string") {
		return { ...m, content: text } as OrchestratorMessages[number]
	}
	return { ...m, content: [{ type: "text" as const, text }] } as OrchestratorMessages[number]
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	const parts: string[] = []
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const text = (block as { text?: string }).text
			if (typeof text === "string") parts.push(text)
		}
	}
	return parts.join("\n")
}

/**
 * Detect user-role (or custom-role, which upstream converts to user-role)
 * messages that are a verbatim echo of the immediately preceding assistant
 * message. This can happen when compaction, nextTurn queues, or client echoes
 * replay the assistant's own text back at the model. Without tagging, the
 * model rationalizes the echo as user approval ("they pasted my response
 * back — that must mean yes").
 *
 * The returned array is the same reference when no echoes are found, so
 * callers can use referential equality to skip extra work.
 */
export function tagSelfEchoes(messages: OrchestratorMessages): OrchestratorMessages {
	let changed = false
	// Text of the most recent assistant message seen so far — carried forward in
	// one pass instead of rescanning the prefix per message (O(n), not O(n²)).
	let prevAssistantText: string | undefined
	const result = messages.map((m) => {
		if (m.role === "assistant") {
			prevAssistantText = extractMessageText(m.content).trim()
			return m
		}
		if (m.role !== "user" && m.role !== "custom") return m

		const text = extractMessageText(m.content).trim()
		if (!text) return m

		if (!prevAssistantText || text !== prevAssistantText) return m

		changed = true
		const annotated = markHarnessSteer(
			"[harness warning: this user-role message is a verbatim echo of your previous assistant message. Treat it as noise — not as user input or approval.]\n\n" +
				text,
		)
		return replaceMessageContent(m, annotated)
	})

	return changed ? result : messages
}

/**
 * Strip UI-only custom messages that are meant for display but should never
 * reach the LLM. These are emitted via `sendMessage` with `display: true` and
 * no `triggerTurn` / `deliverAs` options, which causes pi-mono to push them
 * into `agent.state.messages` as user-role messages.
 */
export function stripUiOnlyMessages(messages: OrchestratorMessages): OrchestratorMessages {
	const filtered = messages.filter((m) => !(isCustomMessage(m) && isUiOnlyCustomType(m)))
	return filtered.length === messages.length ? messages : filtered
}

/**
 * Wrap any unbranded custom message in `<system-reminder>` tags so the model
 * can tell harness-injected content from user-authored text. Upstream
 * converts `role: "custom"` to verbatim `role: "user"` before the LLM call
 * (see steer-marker.ts), so every custom message that reaches context is
 * harness-authored by definition — branding should be an invariant enforced
 * here, at the context boundary, not a convention remembered at every
 * `sendMessage` site. A missed or future steer site (e.g. the behaviour-body
 * steer found during census) can no longer regress to unbranded user-role
 * text silently.
 *
 * Placement in the `context` handler chain: after the taggers
 * (tagSelfEchoes, …), which wrap their own output — so their messages are
 * recognized as already branded and never double-wrapped. The UI_ONLY check
 * is defence in depth: stripUiOnlyMessages runs earlier, but handler
 * ordering across extensions is not a maintained invariant.
 *
 * Returns the same array reference when nothing needs wrapping.
 */
export function brandUnmarkedSteers(messages: OrchestratorMessages): OrchestratorMessages {
	let changed = false
	const result = messages.map((m) => {
		if (!isCustomMessage(m)) return m
		if (isUiOnlyCustomType(m)) return m
		const text = extractMessageText(m.content)
		if (!text.trim()) return m
		if (isHarnessSteer(text)) return m

		changed = true
		const branded = markHarnessSteer(text)
		return replaceMessageContent(m, branded)
	})

	return changed ? result : messages
}
