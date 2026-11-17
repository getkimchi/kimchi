/**
 * subagent-handoff.ts — staging slot for handing running local subagents
 * from one session runtime's AgentManager to the next.
 *
 * pi-mono replaces the whole session runtime on /branch (fork) and /clone:
 * the outgoing runtime emits `session_shutdown {reason:"fork"}` and the
 * replacement emits `session_start {reason, previousSessionFile}`.
 * Extension instances are re-created against the new runtime, so the agents
 * extension's old AgentManager (which owns the running records) is replaced
 * too. This slot carries the still-running local agents across that gap
 * without aborting them: the dying instance stages them keyed by the outgoing
 * session file, and the replacement instance claims them when its
 * `previousSessionFile` matches that key.
 *
 * The map is module-level on purpose — the two extension instances never see
 * each other, they only share the module. It is keyed by the outgoing
 * session file because the ACP server outlives every session: one session's
 * teardown must never touch another session's staged handoff.
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
	/** Ids of records with an in-flight resume at extract time. resume() never
	 *  fires onComplete (pre-existing semantics), so adoption must not start
	 *  notifying for them — not via the settle-gap branch, and not via the
	 *  wrap branch when a resume raced an abort. */
	midResumeIds: Set<string>
	/** Widget activity entries for the handed-off records. */
	activity: Array<[string, AgentActivity]>
}

/** Staged handoffs, keyed by outgoing session file (the lineage key). */
const pending = new Map<string, AgentHandoff>()

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

/** Stage a handoff, replacing any stale one FOR THE SAME lineage key. A
 *  hand-off being evicted can never be claimed — the runtime that would
 *  match its key is already gone — so its records are aborted instead of
 *  running headless. A hand-off without a lineage key (in-memory session
 *  managers) is refused the same way: no replacement could ever claim it. */
export function stageHandoff(handoff: AgentHandoff): void {
	if (handoff.fromSessionFile === undefined) {
		abortRecords(handoff)
		return
	}
	abortRecords(pending.get(handoff.fromSessionFile))
	pending.set(handoff.fromSessionFile, handoff)
}

/** Inspect the staged handoff of one session without claiming it. */
export function peekHandoff(fromSessionFile: string): AgentHandoff | undefined {
	return pending.get(fromSessionFile)
}

/**
 * Claim the staged handoff for the replacement of `previousSessionFile`.
 *
 * Only a real match claims and clears the slot: an undefined key never matches
 * (a fresh boot has no lineage), and a non-match retains the slot — the next
 * replacement may be the one it was staged for. Unclaimed slots are eventually
 * aborted (same-key eviction on re-stage, abortStagedHandoff on the owning
 * session's terminal shutdown, abortAllStagedHandoffs on process quit),
 * never left running headless.
 */
export function takeHandoffFor(previousSessionFile: string | undefined): AgentHandoff | undefined {
	if (previousSessionFile === undefined) return undefined
	const claimed = pending.get(previousSessionFile)
	if (claimed) pending.delete(previousSessionFile)
	return claimed
}

/** Abort and drop the staged handoff of ONE session — the terminal shutdown
 *  paths of its own runtime (resume/new/reload): no replacement of that
 *  session can appear, so its staged records must not keep running. Other
 *  sessions' handoffs are untouched. */
export function abortStagedHandoff(fromSessionFile: string | undefined): void {
	if (fromSessionFile === undefined) return
	abortRecords(pending.get(fromSessionFile))
	pending.delete(fromSessionFile)
}

/** Abort and drop EVERY staged handoff — process quit only: no replacement
 *  runtime of any session can start afterwards, so nothing may run headless. */
export function abortAllStagedHandoffs(): void {
	for (const handoff of pending.values()) abortRecords(handoff)
	pending.clear()
}

/** Clear staged handoffs (test isolation). */
export function clearHandoff(): void {
	pending.clear()
}
