import { AsyncLocalStorage } from "node:async_hooks"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { PARENT_SESSION_ID_ENV_KEY } from "./agents/manager/constants.js"

/**
 * Lets a worker pause its runner's inactivity watchdog during an interactive
 * wait (an escalated permission prompt the user may think about for
 * minutes). The runner installs one handle per run.
 */
export interface AgentWorkerInactivityHold {
	/** Take a hold; returns the release callback (idempotent). */
	acquire(): () => void
}

/** Per-run state for an in-process subagent worker, isolated across parallel runs. */
export interface AgentWorkerInfo {
	/** Watchdog pause for interactive waits, installed by the runner. */
	inactivityHold?: AgentWorkerInactivityHold
	/** Immutable owner of this worker, captured when the worker starts. */
	parentSessionId?: string
}

const workerContext = new AsyncLocalStorage<AgentWorkerInfo>()

/** The session object keeps the owner available when the same worker resumes. */
const parentBySession = new WeakMap<AgentSession, string>()

export function registerWorkerParentSession(session: AgentSession, parentSessionId: string): void {
	parentBySession.set(session, parentSessionId)
}

export function getRegisteredWorkerParentSession(session: AgentSession): string | undefined {
	return parentBySession.get(session)
}

export function isAgentWorker(): boolean {
	return workerContext.getStore() !== undefined || process.env.KIMCHI_SUBAGENT === "1"
}

export function runAsAgentWorker<T>(fn: () => Promise<T>, info: AgentWorkerInfo = {}): Promise<T> {
	// Copy: the store is this run's own object, so later updates stay in the run.
	return workerContext.run({ ...info }, fn)
}

/** Put a resumed session's retained owner into this run's isolated context. */
export function setAgentWorkerParentSessionId(parentSessionId: string | undefined): void {
	const info = workerContext.getStore()
	if (info) info.parentSessionId = parentSessionId
}

/** Resolve the current worker's owner without borrowing a sibling's process env. */
export function getAgentWorkerParentSessionId(): string | undefined {
	const info = workerContext.getStore()
	if (info) return info.parentSessionId
	// A legacy subprocess has a launch-scoped env. An in-process worker with
	// no captured owner must not infer one from another worker's env slot.
	return isAgentWorker() ? process.env[PARENT_SESSION_ID_ENV_KEY] : undefined
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

const AGENT_PERSONA_ENV_KEY = "KIMCHI_AGENT_PERSONA"

/**
 * In-process subagent runs that have their persona in the process
 * environment right now, oldest first. The variable is one slot for the whole
 * process: the commands and hooks a subagent starts read it there.
 */
const personaRuns: Array<{ persona: string }> = []
/** The variable as it was before the first of those runs started. */
let launchAgentPersona: string | undefined

/**
 * Put a subagent run's persona in the process environment, for the commands
 * and hooks the run starts. Returns the function that takes it out again.
 *
 * Runs overlap, so a run cannot put back "the value it found": that value may
 * belong to a sibling that has ended in the meantime, and would then stay in
 * the environment for good. When a run leaves, the variable goes to the
 * latest run that is still active, or back to the launch value after the last.
 */
export function enterAgentPersonaEnv(persona: string): () => void {
	if (personaRuns.length === 0) launchAgentPersona = process.env[AGENT_PERSONA_ENV_KEY]
	const run = { persona }
	personaRuns.push(run)
	process.env[AGENT_PERSONA_ENV_KEY] = persona
	return () => {
		const index = personaRuns.indexOf(run)
		if (index < 0) return
		personaRuns.splice(index, 1)
		const latest = personaRuns.at(-1)
		if (latest) process.env[AGENT_PERSONA_ENV_KEY] = latest.persona
		else if (launchAgentPersona === undefined) Reflect.deleteProperty(process.env, AGENT_PERSONA_ENV_KEY)
		else process.env[AGENT_PERSONA_ENV_KEY] = launchAgentPersona
	}
}

/**
 * The persona this process was launched with. While subagent runs have their
 * own persona in the variable this is still the value from before them: a
 * running Plan subagent must not turn the session that started it into a
 * Plan session.
 */
export function getLaunchAgentPersona(): string | undefined {
	return personaRuns.length > 0 ? launchAgentPersona : process.env[AGENT_PERSONA_ENV_KEY]
}
