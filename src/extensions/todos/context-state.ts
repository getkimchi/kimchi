import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { markHarnessSteer } from "../steer-marker.js"
import { renderTodoStateMarkdown } from "./state-markdown.js"
import { subscribeTodoStore } from "./store.js"

type OrchestratorMessages = ContextEvent["messages"]

export const TODO_STATE_CUSTOM_TYPE = "todo-state"

/** Block persisted when the todo list is cleared after a state block was
 *  already persisted. Constant, so repeated clears dedupe. */
const TODO_CLEARED_MARKDOWN = "## Current Todos\n\nThe todo list was cleared."

function isTodoStateMessage(m: unknown): boolean {
	return (
		m !== null &&
		typeof m === "object" &&
		(m as { role?: string }).role === "custom" &&
		(m as { customType?: string }).customType === TODO_STATE_CUSTOM_TYPE
	)
}

function extractTextContent(content: unknown): string | undefined {
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		for (const part of content) {
			if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
				const text = (part as { text?: unknown }).text
				if (typeof text === "string") return text
			}
		}
	}
	return undefined
}

/**
 * Replay dedupe: find the newest persisted todo-state block in session
 * history so a resumed session does not re-persist an identical block.
 */
function newestTodoStateContentFromHistory(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch()
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i] as { role?: string; customType?: string; content?: unknown }
		if (isTodoStateMessage(m)) {
			return extractTextContent(m.content)
		}
	}
	return undefined
}

/**
 * Persist-on-change delivery of the todo state block.
 *
 * Replaces the previous transient tail-injection: that old design pushed a
 * fresh `todo-state` custom message at the end of the message array inside
 * the `context` handler on every LLM request. Because the request-level
 * cache breakpoint sits on the last block of the stored prefix, every
 * cached prefix ended at a moving message — the tail cache read was
 * permanently poisoned and each request re-wrote the entire prefix.
 *
 * This registrar instead writes the rendered block into session history
 * (as a hidden custom message, delivered as a steer so it lands at the tool
 * boundary) exactly once per actual store change. The persisted entry sits
 * at a fixed chronological position, subsequent requests extend the stream
 * behind it, and it becomes part of the growing stable prefix.
 *
 * History is append-only for extensions (there is no delete API), so
 * superseded copies remain in the branch. The `context` handler registered
 * here is therefore strip-only: it deterministically drops every `todo-state`
 * message except the newest one. The resulting request view is a pure
 * function of persisted history — identical every round until the next real
 * todo write, which is the only moment a bounded prefix invalidation occurs.
 */
export function registerTodoStatePersistence(pi: ExtensionAPI): void {
	/** Per-session newest persisted block content; `undefined` = nothing persisted yet. */
	const lastPersistedContent = new Map<string, string | undefined>()

	function persistIfChanged(sessionId: string): void {
		const markdown = renderTodoStateMarkdown(sessionId)
		let content = markdown === undefined ? undefined : markHarnessSteer(markdown)
		if (content === undefined) {
			if (lastPersistedContent.get(sessionId) === undefined) {
				// Nothing persisted yet and nothing to show — no-op.
				return
			}
			// The list was cleared after a block was persisted: history is
			// append-only, so the previous block would otherwise linger
			// forever (the strip handler keeps the newest copy). Persist a
			// fixed retraction marker so the newest copy states reality.
			content = markHarnessSteer(TODO_CLEARED_MARKDOWN)
		}
		if (content === lastPersistedContent.get(sessionId)) return
		lastPersistedContent.set(sessionId, content)
		pi.sendMessage(
			{
				customType: TODO_STATE_CUSTOM_TYPE,
				display: false,
				content,
				details: { reason: "state_sync" },
			},
			{ deliverAs: "steer" },
		)
	}

	const initFromHistory = (_event: unknown, ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId()
		lastPersistedContent.set(sessionId, newestTodoStateContentFromHistory(ctx))
	}
	pi.on("session_start", initFromHistory)
	pi.on("session_tree", initFromHistory)

	subscribeTodoStore((_details, sessionId) => {
		persistIfChanged(sessionId)
	})

	// Strip-only context pass: drop every todo-state message except the newest.
	// Never appends — the write path (store subscription above) is the only
	// place todo-state messages are created.
	pi.on("context", async (event) => {
		const messages = event.messages
		let newestIndex = -1
		for (let i = 0; i < messages.length; i++) {
			if (isTodoStateMessage(messages[i])) newestIndex = i
		}
		if (newestIndex === -1) return undefined
		const hasSuperseded = messages.some((m, i) => i !== newestIndex && isTodoStateMessage(m))
		if (!hasSuperseded) return undefined

		const stripped: OrchestratorMessages = messages.filter((m, i) => !isTodoStateMessage(m) || i === newestIndex)
		return { messages: stripped }
	})
}
