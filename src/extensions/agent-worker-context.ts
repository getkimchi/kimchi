import { AsyncLocalStorage } from "node:async_hooks"
import { PARENT_SESSION_ID_ENV_KEY } from "./agents/manager/constants.js"

const workerContext = new AsyncLocalStorage<boolean>()

export function isAgentWorker(): boolean {
	return workerContext.getStore() === true || process.env.KIMCHI_SUBAGENT === "1"
}

export function runAsAgentWorker<T>(fn: () => Promise<T>): Promise<T> {
	return workerContext.run(true, fn)
}

/**
 * The spawning (parent) session's pi session id when this process is inside an Agent-subagent run, undefined
 * otherwise. The Agent runner sets KIMCHI_PARENT_SESSION_ID for the whole subagent run; the Agent-worker async
 * context (or KIMCHI_SUBAGENT=1) gates the check so parent-session requests and events are never attributed a parent.
 *
 * Used for both the `session.parent_id` telemetry attribute and the X-Parent-Session-Id provider header.
 */
export function parentSessionId(): string | undefined {
	return isAgentWorker() ? process.env[PARENT_SESSION_ID_ENV_KEY] : undefined
}
