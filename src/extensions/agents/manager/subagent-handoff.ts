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
import type { QueuedAgentHandoff } from "./agent-manager.js"

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

/** Abort a hand-off's records. Used for hand-offs that can no longer be
 *  claimed by any replacement — their records were removed from the outgoing
 *  manager without being aborted, so without this they would run headless
 *  (no widget row, no owning session, spend with no abort path). */
function abortRecords(handoff: AgentHandoff | undefined): void {
	if (!handoff) return
	for (const record of handoff.records) {
		record.abortController?.abort()
	}
}

/** Stage a handoff, replacing any stale one. A hand-off being evicted can
 *  never be claimed — the runtime that would match its lineage key is
 *  already gone — so its records are aborted instead of running headless. */
export function stageHandoff(handoff: AgentHandoff): void {
	abortRecords(pending)
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

/** Abort and drop any staged handoff. For terminal paths (quit, resume to an
 *  unrelated session, reload): no replacement session will claim the slot, so
 *  its records must not keep running. */
export function abortStagedHandoff(): void {
	abortRecords(pending)
	pending = undefined
}

/**
 * Claim the staged handoff for the replacement of `previousSessionFile`.
 *
 * Only a real match claims and clears the slot: an undefined key never matches
 * (a fresh boot has no lineage), and a non-match retains the slot — the next
 * replacement may be the one it was staged for. Unclaimed slots are eventually
 * aborted (stageHandoff eviction, or abortStagedHandoff on a terminal path),
 * never left running headless.
 */
export function takeHandoffFor(previousSessionFile: string | undefined): AgentHandoff | undefined {
	if (pending === undefined || previousSessionFile === undefined) return undefined
	if (pending.fromSessionFile !== previousSessionFile) return undefined
	const claimed = pending
	pending = undefined
	return claimed
}
