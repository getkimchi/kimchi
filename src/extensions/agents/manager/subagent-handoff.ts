/**
 * subagent-handoff.ts — process-level staging slot for handing running local
 * subagents from one session runtime's AgentManager to the next.
 *
 * pi-mono replaces the whole session runtime on /branch (fork), /clone, and
 * /new: the outgoing runtime emits `session_shutdown {reason:"fork"|"new"}`
 * and the replacement emits `session_start {reason, previousSessionFile}`.
 * Extension instances are re-created against the new runtime, so the agents
 * extension's old AgentManager (which owns the running records) is replaced
 * too. This slot carries the still-running local agents across that gap
 * without aborting them: the dying instance stages them keyed by the outgoing
 * session file, and the replacement instance claims them when its
 * `previousSessionFile` matches that key.
 *
 * The slot is module-level on purpose — the two extension instances never see
 * each other, they only share the module. It holds at most one pending
 * handoff; staging again replaces a stale one (the previous runtime died
 * without a matching replacement, e.g. sequential forks).
 */

import type { AgentRecord } from "../personas/types.js"
import type { AgentActivity } from "../ui/agent-widget.js"
import type { QueuedAgentHandoff, SpawnOptions } from "./agent-manager.js"

/** Running local agents handed from an outgoing session runtime to its replacement. */
export interface AgentHandoff {
	/** Outgoing session file — the lineage key the replacement's
	 *  `session_start.previousSessionFile` must match to claim the handoff. */
	fromSessionFile: string | undefined
	/** Running local records extracted from the outgoing manager (ids preserved:
	 *  the orchestrator LLM already holds them). */
	records: AgentRecord[]
	/** Queue entries (not yet started) drained from the outgoing manager. */
	queued: QueuedAgentHandoff[]
	/** Widget activity entries for the handed-off records. */
	activity: Array<[string, AgentActivity]>
}

let pending: AgentHandoff | undefined

/** Stage a handoff, replacing any stale one. */
export function stageHandoff(handoff: AgentHandoff): void {
	pending = handoff
}

/** Inspect the staged handoff without claiming it. */
export function peekHandoff(): AgentHandoff | undefined {
	return pending
}

/** Drop any staged handoff. */
export function clearHandoff(): void {
	pending = undefined
}

/**
 * Claim the staged handoff for the replacement of `previousSessionFile`.
 *
 * Only a real match claims and clears the slot: an undefined key never matches
 * (a fresh boot has no lineage), and a non-match retains the slot — the next
 * replacement may be the one it was staged for. Fail-closed: an unclaimed
 * handoff simply dies with the process, degrading to today's behavior.
 */
export function takeHandoffFor(previousSessionFile: string | undefined): AgentHandoff | undefined {
	if (pending === undefined || previousSessionFile === undefined) return undefined
	if (pending.fromSessionFile !== previousSessionFile) return undefined
	const claimed = pending
	pending = undefined
	return claimed
}
