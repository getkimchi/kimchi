import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { renderTodoStateMarkdown } from "./prompt-block.js"

type OrchestratorMessages = ContextEvent["messages"]

const TODO_STATE_CUSTOM_TYPE = "todo-state"

/**
 * Messages helper that knows how to strip todo-state injections from a
 * transient message array. Follows the same pattern as `stripStaleNudges`
 * in continuation-nudge.ts but targets this extension's custom type.
 */
function stripTodoStateMessages(messages: OrchestratorMessages): OrchestratorMessages {
	return messages.filter(
		(m) =>
			!(
				m.role === "custom" &&
				"customType" in m &&
				(m as { customType: string }).customType === TODO_STATE_CUSTOM_TYPE
			),
	)
}

/**
 * Registers a `context` event handler that injects the current todo state
 * at the tail of the message array on every LLM call. This is transient —
 * the injected message lives only in the single LLM request, never in the
 * persistent session history, and never touches the system prompt.
 *
 * Replaces the previous `before_agent_start` system-prompt injection for
 * the state block. The `## Todos` guidance block stays in the system
 * prompt (static, cache-friendly); only the dynamic state moves here.
 */
export function registerTodoContextState(pi: ExtensionAPI): void {
	pi.on("context", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId()
		const stateMarkdown = renderTodoStateMarkdown(sessionId)
		if (!stateMarkdown) return undefined

		// Defensive strip: if another handler in the chain already injected
		// an older copy of todo-state, drop it so we never double-stack.
		const messages = stripTodoStateMessages(event.messages)

		messages.push({
			role: "custom",
			customType: TODO_STATE_CUSTOM_TYPE,
			content: stateMarkdown,
			display: false,
			timestamp: Date.now(),
		})

		return { messages }
	})
}
