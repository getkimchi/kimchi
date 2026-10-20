import { AsyncLocalStorage } from "node:async_hooks"
import { PARENT_SESSION_ID_ENV_KEY } from "./agents/manager/constants.js"

const workerContext = new AsyncLocalStorage<boolean>()

export function isAgentWorker(): boolean {
	return workerContext.getStore() === true || process.env.KIMCHI_SUBAGENT === "1"
}

export function runAsAgentWorker<T>(fn: () => Promise<T>): Promise<T> {
	return workerContext.run(true, fn)
}

/** The spawning session's pi session id inside an Agent-subagent run; a parent session never gets one. */
export function parentSessionId(): string | undefined {
	return isAgentWorker() ? process.env[PARENT_SESSION_ID_ENV_KEY] : undefined
}
