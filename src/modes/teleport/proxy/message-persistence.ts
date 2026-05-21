/**
 * Persist a single message to the local sessionManager so InteractiveMode can
 * render historical messages after re-attaching or swapping foreground.
 */
export function persistMessage(sessionManager: unknown, msg: unknown): void {
	const sm = sessionManager as
		| {
				appendMessage?: (m: unknown) => void
				getEntries?: () => Array<{ type?: string }>
		  }
		| undefined
	if (!sm?.appendMessage) return
	const role = (msg as { role?: unknown }).role
	if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "bashExecution") return
	sm.appendMessage(msg)
}

/**
 * Backfill messages from a fetched array that are not yet present in the local
 * sessionManager. Uses a simple count heuristic to avoid double-appending
 * messages already persisted via live events.
 */
export function syncMessagesToSessionManager(sessionManager: unknown, messages: Array<Record<string, unknown>>): void {
	const sm = sessionManager as
		| {
				appendMessage?: (m: unknown) => void
				getEntries?: () => Array<{ type?: string }>
		  }
		| undefined
	if (!sm?.appendMessage || !sm.getEntries) return
	const existingMessageCount = sm.getEntries().filter((e) => e.type === "message").length
	for (let i = existingMessageCount; i < messages.length; i++) {
		const msg = messages[i]
		const role = msg.role
		if (role === "user" || role === "assistant" || role === "toolResult") {
			sm.appendMessage(msg)
		}
	}
}
