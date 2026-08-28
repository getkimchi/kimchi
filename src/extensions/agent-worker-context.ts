import { AsyncLocalStorage } from "node:async_hooks"
import crypto from "node:crypto"

const workerContext = new AsyncLocalStorage<boolean>()

// Per-trajectory conversation id. The module-level default is used by the
// main agent; runAsAgentWorker() pushes a fresh UUID onto the async context
// so each subagent trajectory gets its own id.
const conversationIdStorage = new AsyncLocalStorage<string>()
let defaultConversationId = crypto.randomUUID()

export function getConversationId(): string {
	return conversationIdStorage.getStore() ?? defaultConversationId
}

/** Regenerate the main-agent conversation id (called on session_start / `/new`). */
export function resetConversationId(): void {
	defaultConversationId = crypto.randomUUID()
}

export function isAgentWorker(): boolean {
	return workerContext.getStore() === true || process.env.KIMCHI_SUBAGENT === "1"
}

export function runAsAgentWorker<T>(fn: () => Promise<T>): Promise<T> {
	const workerConversationId = crypto.randomUUID()
	return conversationIdStorage.run(workerConversationId, () => workerContext.run(true, fn))
}
