import { AsyncLocalStorage } from "node:async_hooks"

/** Per-run state for an in-process subagent worker, isolated across parallel runs. */
/**
 * Lets a worker pause its runner's inactivity watchdog during an interactive
 * wait (an escalated permission prompt the user may think about for
 * minutes). The runner installs one handle per run.
 */
export interface AgentWorkerInactivityHold {
	/** Take a hold; returns the release callback (idempotent). */
	acquire(): () => void
}

export interface AgentWorkerInfo {
	/** Watchdog pause for interactive waits, installed by the runner. */
	inactivityHold?: AgentWorkerInactivityHold
}

const workerContext = new AsyncLocalStorage<AgentWorkerInfo>()

export function isAgentWorker(): boolean {
	return workerContext.getStore() !== undefined || process.env.KIMCHI_SUBAGENT === "1"
}

export function runAsAgentWorker<T>(fn: () => Promise<T>, info: AgentWorkerInfo = {}): Promise<T> {
	// Copy: the store is this run's own object, so later updates stay in the run.
	return workerContext.run({ ...info }, fn)
}

/**
 * Install the watchdog hold for this run — the runner calls it once it owns
 * its inactivity state. No-op outside an in-process worker.
 */
export function setAgentWorkerInactivityHold(hold: AgentWorkerInactivityHold | undefined): void {
	const info = workerContext.getStore()
	if (info) info.inactivityHold = hold
}

/**
 * Pause the inactivity watchdog for the duration of an interactive wait.
 * Returns the release callback; a no-op outside a worker or when the runner
 * installed no hold (so the same code path is safe in subprocess workers).
 */
export function holdAgentWorkerInactivity(): () => void {
	return workerContext.getStore()?.inactivityHold?.acquire() ?? (() => {})
}

/**
 * Run `fn` outside the current worker context. A parent session's surface
 * handlers (its registered classifier-notice / escalated-prompt sink) are
 * invoked from a WORKER's async chain — AsyncLocalStorage propagates by call
 * site — so anything that must see the parent's identity (resolving the
 * parent's prompter, which refuses workers) is wrapped in this.
 */
export function runOutsideWorkerContext<T>(fn: () => T): T {
	return workerContext.exit(fn)
}
