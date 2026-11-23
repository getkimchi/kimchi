/**
 * Session-scoped registry of parent surfaces.
 *
 * A session that can reach its user (toasts and permission prompts) registers
 * a surface under its own session ID so that subagent workers (which have no
 * UI and no prompt route of their own) can hand it three kinds of work:
 *
 * - `notify`: permission-classifier warnings, shown in the parent's surface;
 * - `requestPermission` (present only when the session can prompt): an
 *   escalated permission prompt, shown in the parent on the worker's behalf
 *   when the worker's classifier is unavailable or another decision requires
 *   approval. The caller awaits the user's outcome; a thrown error means the
 *   route failed (stale surface, timeout) and the caller must fail closed.
 *   A mode change instead withdraws the prompt for fresh policy evaluation.
 * - `reportEscalatedCall`: where a call that was asked about stands now. The
 *   worker reports it after its gate has decided and again after the tool has
 *   run, so a client-side card shows what happened to the call and not only
 *   what was answered.
 *
 * A worker reads its parent's session ID from the immutable role supplied
 * by the runner, then looks the surface up here.
 *
 * Same multi-owner slot reasoning as `mode-controller-registry.ts`:
 * concurrent same-ID attaches (load+resume coalescing) can both register
 * before either installs its record — a plain Map.set could displace a LIVE
 * winner's entry, after which the loser's legitimately identity-checked
 * teardown would evict it. Registrations push; identity-checked removals pop
 * only their own object.
 */

import type { EscalatedCallReport, PermissionRequest } from "./prompter.js"
import type { ApprovalOutcome } from "./prompts.js"

/** Severity for a classifier notice; maps onto `ui.notify` levels. */
export type ParentSurfaceLevel = "warning" | "info"

export interface ParentSurface {
	notify: (message: string, level: ParentSurfaceLevel) => void
	/** Show a permission prompt in this session's UI on a subagent's behalf.
	 *  Rejects when the route fails — the caller falls back to blocking. */
	requestPermission?: (req: PermissionRequest) => Promise<ApprovalOutcome>
	/** Tell this session's surface where a call it was asked about stands
	 *  now: running, completed or failed. Best effort; never throws. */
	reportEscalatedCall?: (report: EscalatedCallReport) => void
}

const bySessionId = new Map<string, ParentSurface[]>()
const pendingRequests = new Map<string, Map<string, Map<string, AbortController>>>()
const UNKNOWN_AGENT_KEY = "unknown-agent"

/** Keep an abortable parent prompt linked to its worker and call for cancellation and cleanup. */
export function registerEscalationAbort(
	sessionId: string,
	toolCallId: string,
	controller: AbortController,
	agentId?: string,
): () => void {
	const agentKey = agentId ?? UNKNOWN_AGENT_KEY
	let requestsByAgent = pendingRequests.get(sessionId)
	if (!requestsByAgent) {
		requestsByAgent = new Map<string, Map<string, AbortController>>()
		pendingRequests.set(sessionId, requestsByAgent)
	}
	let requests = requestsByAgent.get(agentKey)
	if (!requests) {
		requests = new Map<string, AbortController>()
		requestsByAgent.set(agentKey, requests)
	}
	requests.set(toolCallId, controller)
	return () => {
		const byAgent = pendingRequests.get(sessionId)
		if (!byAgent) return
		const current = byAgent.get(agentKey)
		if (current?.get(toolCallId) !== controller) return
		current.delete(toolCallId)
		if (current.size === 0) byAgent.delete(agentKey)
		if (byAgent.size === 0) pendingRequests.delete(sessionId)
	}
}

/** Withdraw every escalated request currently owned by a parent session. */
export function cancelEscalatedRequests(sessionId: string, reason: unknown): void {
	const requestsByAgent = pendingRequests.get(sessionId)
	if (!requestsByAgent) return
	for (const requests of requestsByAgent.values()) {
		for (const controller of requests.values()) controller.abort(reason)
	}
	pendingRequests.delete(sessionId)
}

/**
 * Register a parent surface for a specific session.
 */
export function registerParentSurface(sessionId: string, surface: ParentSurface): void {
	const list = bySessionId.get(sessionId) ?? []
	list.push(surface)
	bySessionId.set(sessionId, list)
}

/**
 * Unregister a session's parent surface. Session IDs recycle across
 * concurrent attaches, respawns, and failed loads, so callers that registered
 * a SPECIFIC surface pass it back for an identity check — removing by key
 * alone could evict a LIVE session's surface. Without `expected` the whole
 * slot is dropped. Returns whether the requested removal left the slot empty.
 */
export function unregisterParentSurface(sessionId: string, expected?: ParentSurface): boolean {
	const list = bySessionId.get(sessionId)
	if (!list) return true
	if (expected === undefined) {
		bySessionId.delete(sessionId)
		return true
	}
	const idx = list.lastIndexOf(expected)
	if (idx < 0) return list.length === 0
	list.splice(idx, 1)
	if (list.length === 0) {
		bySessionId.delete(sessionId)
		return true
	}
	return false
}

/**
 * Get a session's parent surface if one exists (the latest registration).
 */
export function getParentSurface(sessionId: string): ParentSurface | undefined {
	const list = bySessionId.get(sessionId)
	return list?.[list.length - 1]
}
