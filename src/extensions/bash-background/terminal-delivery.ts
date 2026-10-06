/**
 * Session-owned terminal-delivery state for background bash.
 *
 * Represents the delivery lifecycle of a terminal outcome SEPARATELY from
 * process liveness (process-registry.ts) and wait timing
 * (review-coordinator.ts): a process that exited is not "done" until its
 * terminal payload is committed to an authoritative conversation message
 * — its tool result or an identified automatic exit notification.
 *
 * Ownership model (exactly one authoritative channel per outcome):
 *
 *  - `available` — the outcome is recorded but unclaimed. Any channel may
 *    claim it: the automatic notification path (`claimAutomaticEnqueue`)
 *    or a `bash_control` call (`claimControl`).
 *  - `queued` — the automatic channel has enqueued its identified
 *    steering message (`markQueued` runs synchronously BEFORE
 *    `pi.sendMessage`, because an idle `triggerTurn` can start processing
 *    immediately). Ownership is then irreversible: a racing inspection
 *    reports the pending status instead of duplicating the payload.
 *  - `delivered` — acknowledged in the authoritative conversation and
 *    retired (removed from this table).
 *
 * Acknowledgement seams (verified against installed
 * @earendil-works/pi-coding-agent@0.85.1 / pi-agent-core@0.85.1):
 *
 *  - Automatic messages: the core loop emits `message_start`/`message_end`
 *    for each injected steering message and pushes it into the run context
 *    immediately after (agent-loop.js runLoop). An idle `triggerTurn`
 *    dispatch (`_runAgentPrompt`) emits the same events for the trigger
 *    messages before the first assistant response. Either way,
 *    `message_end` with our customType + details reaches extension
 *    handlers BEFORE session persistence — the outcome is committed to
 *    the conversation the next provider request will see.
 *  - Tool-owned outcomes: the `tool_result` extension event fires from
 *    `agent.afterToolCall`, before the result message is appended to the
 *    run context — the consolidated `bash_control` result carrying
 *    `exitedHandles` is authoritative by construction.
 *
 * Recovery (abort / queue clear):
 *
 *  Kimchi's TUI (Escape) and ACP (`cancel`) DROP queued steering on user
 *  abort (clearAllQueues / clearQueue before session.abort()). A queued
 *  outcome whose run terminated with `stopReason` "aborted"/"error" is
 *  therefore released back to `available` (`releaseAutomatic`) so a later
 *  explicit inspection can deliver it. If the message was NOT actually
 *  dropped (a programmatic abort keeps the queue) and arrives late, the
 *  pending was already claimed/delivered by the control channel: the
 *  extension's `message_end` handler then REPLACES the stale message with
 *  a suppression note (the SDK's message_end replacement hook mutates the
 *  message in place for context AND persistence), so the authoritative
 *  payload is never repeated.
 *
 * This module is intentionally free of any `ExtensionAPI` dependency so it
 * stays unit-testable.
 */
import { randomUUID } from "node:crypto"

/** Lifecycle phase of one pending terminal outcome. */
export type TerminalDeliveryPhase = "available" | "queued"

/** Who owns delivering one terminal outcome. */
export type TerminalOwner = "automatic" | { controlCallId: string }

/** One retained terminal outcome awaiting authoritative delivery. */
export interface PendingTerminal {
	/** Background handle this outcome belongs to. */
	readonly handle: string
	/** Stable identity of the delivery attempt (batch) that carries this payload. Assigned at enqueue time. */
	deliveryId: string
	/** Immutable formatted terminal-result block. */
	readonly payload: string
	phase: TerminalDeliveryPhase
	owner: TerminalOwner
}

/** Typed `details` carried by every automatic exit notification. */
export interface BashExitMessageDetails {
	/** Stable identity of this delivery attempt; acknowledged via message_end. */
	deliveryId: string
	/** Identity of the BashSessionState that enqueued the message (session generation guard). */
	sessionId: string
	/** Every handle whose terminal payload this message carries. */
	handles: string[]
}

/** Result of acknowledging an automatic message by delivery identity. */
export type AcknowledgeResult = "delivered" | "superseded"

export interface TerminalDelivery {
	/** Unique identity of this state instance (session generation guard for message acknowledgements). */
	readonly sessionId: string
	/**
	 * Record a freshly collected terminal outcome. The payload is retained
	 * here until an authoritative acknowledgement retires it.
	 */
	record(handle: string, payload: string, owner: TerminalOwner): PendingTerminal
	/**
	 * Atomically claim `handle` for a `bash_control` call. Succeeds only
	 * while the outcome is `available`; returns undefined when it is already
	 * queued for the automatic channel or claimed by another call.
	 */
	claimControl(handle: string, controlCallId: string): PendingTerminal | undefined
	/**
	 * Transition `handle`'s automatic-owned outcome to `queued` with
	 * `deliveryId`. Returns the pending when it was still claimable by the
	 * automatic channel (available + automatic); undefined when a control
	 * call claimed it in the meantime (the tool result delivers it).
	 */
	markQueued(handle: string, deliveryId: string): PendingTerminal | undefined
	/**
	 * Acknowledge the automatic message identified by `deliveryId`.
	 * "delivered": its outcomes were still automatic-owned — retire them.
	 * "superseded": no live entry matches (already retired, control-claimed,
	 * or an unknown/stale identity) — the caller must suppress the message
	 * payload so it is not repeated.
	 */
	acknowledgeAutomatic(deliveryId: string): AcknowledgeResult
	/**
	 * Acknowledge tool-owned delivery of `handles` (the consolidated
	 * bash_control result carried them). Idempotent; ignores automatic
	 * channel ownership only when the entry was never claimed by a control
	 * call (defensive — the tool only lists handles it actually delivered).
	 */
	acknowledgeControl(handles: readonly string[]): void
	/**
	 * Release every queued automatic outcome back to `available` after the
	 * run terminated (abort/error): kimchi drops queued steering on user
	 * cancellation, so the outcomes must stay recoverable. Returns the
	 * released handles.
	 */
	releaseAutomatic(): string[]
	/**
	 * Roll back one batch enqueue attempt after a synchronous send failure:
	 * only the outcomes of `deliveryId` return to `available` so they stay
	 * recoverable by inspection (no retry loop, no duplicate enqueue).
	 */
	releaseQueued(deliveryId: string): string[]
	/** Release a control call's claim without delivering (failed call). Returns released handles. */
	releaseControl(controlCallId: string): string[]
	/** The pending outcome for `handle`, or undefined. */
	getPending(handle: string): PendingTerminal | undefined
	/** Every handle with an undelivered terminal outcome. */
	pendingHandles(): string[]
	/** Whether any terminal outcome awaits delivery. */
	hasPending(): boolean
	/** Whether an automatic notification awaits conversation acknowledgement. */
	hasQueuedAutomatic(): boolean
	/** Observe automatic enqueue transitions. Returns a subscription cleanup. */
	onQueuedAutomatic(listener: () => void): () => void
	/** Total live entries (live + pending-terminal for assertions). */
	readonly size: number
}

export function createTerminalDelivery(): TerminalDelivery {
	const pendings = new Map<string, PendingTerminal>()
	const queuedListeners = new Set<() => void>()
	const sessionId = randomUUID()

	function record(handle: string, payload: string, owner: TerminalOwner): PendingTerminal {
		const pending: PendingTerminal = {
			handle,
			deliveryId: randomUUID(),
			payload,
			phase: "available",
			owner,
		}
		pendings.set(handle, pending)
		return pending
	}

	function claimControl(handle: string, controlCallId: string): PendingTerminal | undefined {
		const pending = pendings.get(handle)
		// Only an available, automatic-owned outcome can be claimed: a
		// queued outcome belongs irreversibly to the automatic channel, and
		// another call's claim is never stolen.
		if (pending?.phase !== "available" || pending.owner !== "automatic") return undefined
		pending.owner = { controlCallId }
		return pending
	}

	function markQueued(handle: string, deliveryId: string): PendingTerminal | undefined {
		const pending = pendings.get(handle)
		if (pending?.phase !== "available" || pending.owner !== "automatic") return undefined
		pending.phase = "queued"
		pending.deliveryId = deliveryId
		for (const listener of queuedListeners) listener()
		return pending
	}

	function acknowledgeAutomatic(deliveryId: string): AcknowledgeResult {
		const entries = [...pendings.values()].filter((p) => p.deliveryId === deliveryId)
		if (entries.length === 0) return "superseded"
		// An outcome claimed by a control call after an abort-release is
		// delivered by that call's tool result: the arriving automatic
		// message is stale and must be suppressed.
		if (entries.some((p) => p.owner !== "automatic")) return "superseded"
		for (const entry of entries) pendings.delete(entry.handle)
		return "delivered"
	}

	function acknowledgeControl(handles: readonly string[]): void {
		for (const handle of handles) {
			pendings.delete(handle)
		}
	}

	function releaseAutomatic(): string[] {
		const released: string[] = []
		for (const pending of pendings.values()) {
			if (pending.phase === "queued" && pending.owner === "automatic") {
				pending.phase = "available"
				released.push(pending.handle)
			}
		}
		return released
	}

	function releaseQueued(deliveryId: string): string[] {
		const released: string[] = []
		for (const pending of pendings.values()) {
			if (pending.phase === "queued" && pending.owner === "automatic" && pending.deliveryId === deliveryId) {
				pending.phase = "available"
				released.push(pending.handle)
			}
		}
		return released
	}

	function releaseControl(controlCallId: string): string[] {
		const released: string[] = []
		for (const pending of pendings.values()) {
			if (
				pending.phase === "available" &&
				pending.owner !== "automatic" &&
				pending.owner.controlCallId === controlCallId
			) {
				pending.owner = "automatic"
				released.push(pending.handle)
			}
		}
		return released
	}

	return {
		sessionId,
		record,
		claimControl,
		markQueued,
		acknowledgeAutomatic,
		acknowledgeControl,
		releaseAutomatic,
		releaseQueued,
		releaseControl,
		getPending: (handle) => pendings.get(handle),
		pendingHandles: () => [...pendings.keys()],
		hasPending: () => pendings.size > 0,
		hasQueuedAutomatic: () => [...pendings.values()].some((p) => p.phase === "queued" && p.owner === "automatic"),
		onQueuedAutomatic(listener) {
			queuedListeners.add(listener)
			return () => {
				queuedListeners.delete(listener)
			}
		},
		get size() {
			return pendings.size
		},
	}
}
