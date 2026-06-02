import { AsyncLocalStorage } from "node:async_hooks"

export interface AgentWorkerContext {
	agentId?: string
	agentLabel?: string
}

const workerContext = new AsyncLocalStorage<AgentWorkerContext>()

export function isAgentWorker(): boolean {
	return workerContext.getStore() !== undefined || process.env.KIMCHI_SUBAGENT === "1"
}

export function getAgentWorkerId(): string | undefined {
	return workerContext.getStore()?.agentId ?? process.env.KIMCHI_SUBAGENT_ID
}

export function getAgentWorkerLabel(): string | undefined {
	return workerContext.getStore()?.agentLabel ?? process.env.KIMCHI_SUBAGENT_LABEL
}

export function runAsAgentWorker<T>(fn: () => Promise<T>, context: AgentWorkerContext = {}): Promise<T> {
	return workerContext.run(context, fn)
}
