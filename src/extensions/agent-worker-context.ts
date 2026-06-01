import { AsyncLocalStorage } from "node:async_hooks"

/** Per-run worker context. Presence of the store object marks "I am a subagent".
 *  `structuredOutput` is populated when a persona's bound submit tool fires
 *  (see AgentConfig.outputToolName); it stays undefined for every other agent. */
interface WorkerContext {
	structuredOutput?: unknown
}

const workerContext = new AsyncLocalStorage<WorkerContext>()

export function isAgentWorker(): boolean {
	return workerContext.getStore() !== undefined || process.env.KIMCHI_SUBAGENT === "1"
}

export function runAsAgentWorker<T>(fn: () => Promise<T>): Promise<T> {
	return workerContext.run({}, fn)
}

/** Record a subagent's schema-validated result. Called from a persona's bound
 *  submit tool handler; the value surfaces as RunResult.structuredOutput. No-op
 *  outside a worker run. */
export function setAgentStructuredOutput(value: unknown): void {
	const ctx = workerContext.getStore()
	if (ctx) ctx.structuredOutput = value
}

/** Read the structured output captured for the current worker run, or undefined
 *  if none was submitted (or not running inside a worker). */
export function getAgentStructuredOutput(): unknown {
	return workerContext.getStore()?.structuredOutput
}
