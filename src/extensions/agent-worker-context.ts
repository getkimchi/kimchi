// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { AsyncLocalStorage } from "node:async_hooks"

const workerContext = new AsyncLocalStorage<boolean>()

export function isAgentWorker(): boolean {
	return workerContext.getStore() === true || process.env.KIMCHI_SUBAGENT === "1"
}

export function runAsAgentWorker<T>(fn: () => Promise<T>): Promise<T> {
	return workerContext.run(true, fn)
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
