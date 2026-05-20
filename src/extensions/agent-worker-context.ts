import { AsyncLocalStorage } from "node:async_hooks"

const workerContext = new AsyncLocalStorage<boolean>()

export function isAgentWorker(): boolean {
	return workerContext.getStore() === true || process.env.KIMCHI_SUBAGENT === "1"
}

export function runAsAgentWorker<T>(fn: () => Promise<T>): Promise<T> {
	return workerContext.run(true, fn)
}
