/**
 * `bash_control` extension — cohort tracking, immediate exits, completion guard.
 *
 * Registers the `bash_control` companion tool (from `./bash-control-tool.js`)
 * and owns everything model-facing about a background cohort that is NOT a
 * direct tool call: immediate unattended-exit notifications, the
 * once-per-turn concurrency steer, and the completion continuation guard.
 * It NEVER hard-blocks other tool calls, and there is NO recurring review
 * clock — while the agent does independent work, nothing wakes the model;
 * only exits (and explicit waits) produce messages.
 *
 * Delivery contract (exactly-once per terminal state; see
 * ./terminal-delivery.ts for the owning state machine):
 *
 *  - Every process retains a `whenExited` watcher. An exit is delivered
 *    immediately, never held for a periodic review. Exits pending in the
 *    same scheduling boundary are coalesced into one message (microtask
 *    flush — no multi-second delay, no batching timer).
 *  - Exit of a handle owned by an active `bash_control` call (waits own
 *    every handle including joiners; inspections and stop-lists own the
 *    handles they may collect) is claimed silently — that call's
 *    consolidated tool result is the authoritative delivery, acknowledged
 *    when the extension observes the result's `exitedHandles`. If the call
 *    ends without delivering it, the notification fires from
 *    `tool_execution_end` (recorded payloads are requeued without
 *    re-collection).
 *  - An unattended exit snapshots the terminal result, records it in the
 *    session's terminal-delivery state (available for recovery until
 *    acknowledged), removes the handle, and calls
 *    `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`.
 *    Steering is consumed at the NEXT TURN BOUNDARY of the running loop
 *    (installed pi-agent-core runLoop polls steering after tool results,
 *    before the next assistant response), so a model that keeps calling
 *    tools still receives the result without a tool-free stop. An idle
 *    agent is woken by `triggerTurn` instead.
 *  - The steering message carries typed `details` (deliveryId, sessionId,
 *    all represented handles). Its `message_end` event — emitted by the
 *    installed loop when the message is injected into the run context,
 *    before the next provider request — is the authoritative
 *    acknowledgement: the pending outcomes retire then, not before.
 *  - User cancellation / provider error: the last assistant stopReason
 *    (`aborted`/`error`) suppresses `triggerTurn` for later unattended
 *    exits (no inference restart of a cancelled run — the message is
 *    appended to the conversation without waking it) and releases queued
 *    automatic outcomes back to recoverable state, because kimchi's TUI
 *    (Escape) and ACP (`cancel`) drop queued steering on abort. A late
 *    arrival of a recovered-and-re-delivered outcome is suppressed via the
 *    message_end replacement hook, so the payload is never repeated.
 *
 * Concurrency context: while any handle is tracked, write/execute tool
 * calls (shared permission taxonomy) receive at most one advisory steer
 * per turn — reinforcement, never a gate.
 *
 * Completion continuation: EVERY normal assistant stop
 * (`stopReason === "stop"`) with unresolved managed work — running
 * processes or terminal outcomes awaiting authoritative delivery — queues
 * one consolidated hidden follow-up directing the model to wait or stop.
 * The follow-up keeps the agent run unsettled (the agent loop drains
 * queued follow-ups before stopping), so a task cannot settle
 * successfully while work lacks a disposition. When the only unresolved
 * items are outcomes whose identified steering notification is already
 * queued, the reminder is redundant (the notification itself continues
 * the run) and is suppressed. User cancellation, provider errors, token
 * exhaustion, and shutdown never trigger it.
 */

import { randomUUID } from "node:crypto"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import { classifyTool } from "../permissions/taxonomy.js"
import { createToolVisibility } from "../prompt-construction/tool-visibility.js"
import { markHarnessSteer } from "../steer-marker.js"
import { BASH_CONTROL_TOOL_NAME, createBashControlToolDefinition } from "./bash-control-tool.js"
import { elapsedSecondsSince } from "./process-registry.js"
import { type BashSessionState, getSessionState } from "./session-registry.js"
import { terminalResultText } from "./status-text.js"
import type { BashExitMessageDetails, TerminalOwner } from "./terminal-delivery.js"

/** Custom message type for an unattended process-exit notification. */
export const BASH_BACKGROUND_EXIT_MESSAGE_TYPE = "bash-background-exit"
/** Custom message type for the once-per-turn concurrency reinforcement steer. */
export const BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE = "bash-background-concurrency"
/** Custom message type for the completion-continuation follow-up. */
export const BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE = "bash-background-completion"

export interface BashControlExtensionOptions {
	/** Override the state accessor (tests inject a controllable fake). */
	getState?: () => BashSessionState | undefined
}

/** The subset of bash/bash_control result details this extension reads. */
interface BackgroundResultDetails {
	handle?: string
	handoff?: boolean
	exited?: boolean
	exitedHandles?: string[]
	runningHandles?: string[]
}

/** Runtime-guarded read of tool_result `details` (typed `unknown` upstream). */
function readDetails(raw: unknown): BackgroundResultDetails {
	if (!raw || typeof raw !== "object") return {}
	const d = raw as Record<string, unknown>
	return {
		handle: typeof d.handle === "string" ? d.handle : undefined,
		handoff: d.handoff === true,
		exited: d.exited === true,
		exitedHandles: Array.isArray(d.exitedHandles)
			? d.exitedHandles.filter((h): h is string => typeof h === "string")
			: undefined,
		runningHandles: Array.isArray(d.runningHandles)
			? d.runningHandles.filter((h): h is string => typeof h === "string")
			: undefined,
	}
}

/** Runtime-guarded read of an exit notification's typed `details`. */
function readExitMessageDetails(raw: unknown): BashExitMessageDetails | undefined {
	if (!raw || typeof raw !== "object") return undefined
	const d = raw as Record<string, unknown>
	if (typeof d.deliveryId !== "string" || typeof d.sessionId !== "string") return undefined
	if (!Array.isArray(d.handles) || !d.handles.every((h) => typeof h === "string")) return undefined
	return { deliveryId: d.deliveryId, sessionId: d.sessionId, handles: d.handles as string[] }
}

/** Build the concurrency reinforcement steer text for a set of tracked handles. */
function formatConcurrencySteer(handles: readonly string[]): string {
	const plural = handles.length !== 1
	const list = handles.join(", ")
	return (
		`${plural ? "Background bash processes are" : "A background bash process is"} still running: ${list}. ` +
		"This write/execute call was allowed, but it may conflict with the running process — " +
		"shared files, package managers, ports, build outputs, or process state. " +
		"If this work overlaps, check the process status or stop it with bash_control stop_handles first; " +
		"otherwise proceed."
	)
}

/**
 * Build the completion-continuation follow-up text: every unresolved
 * process with its current disposition state (running vs
 * exited-but-undelivered). Only waiting or explicit stopping release the
 * guard — a prose assertion of irrelevance does not.
 */
function formatCompletionContinuation(running: readonly string[], awaitingDelivery: readonly string[]): string {
	const parts: string[] = []
	if (running.length > 0) {
		parts.push(`Still running: ${running.join(", ")}.`)
	}
	if (awaitingDelivery.length > 0) {
		parts.push(`Exited, results not yet delivered: ${awaitingDelivery.join(", ")}.`)
	}
	return (
		"Task completion requires a disposition for unresolved background bash processes. " +
		parts.join(" ") +
		"Do ONE of: (1) call bash_control with wait: true to block for the next cohort event in a single batch; " +
		"(2) call bash_control with stop_handles for every process no longer needed, and report accurately what remains unfinished. " +
		"Managed background bash is killed at session shutdown (unlike `daemon` processes), so unfinished work or uncollected output may be lost. " +
		"Do not end the task while anything remains unresolved."
	)
}

/** Ownership an in-flight bash_control call holds over exits. */
interface ActiveControlCall {
	/**
	 * wait: true — owns every cohort exit for the call's duration (joiners
	 * claimed on spawn). Inspections and stop-lists claim only the handles
	 * they may collect.
	 */
	wait: boolean
	/**
	 * Handles whose terminal results this call may deliver: every bash_control
	 * call sweeps available terminal results for the whole cohort, so each
	 * claims every tracked handle up front.
	 */
	owned: Set<string>
}

export default function bashControlExtension(pi: ExtensionAPI, options?: BashControlExtensionOptions): void {
	const getState = options?.getState ?? getSessionState
	// Tracked background handles whose lifecycle is not yet resolved.
	// Non-blocking: the extension steers on conflicts but never blocks tools.
	let trackedHandles = new Set<string>()
	// bash_control executions in flight: toolCallId -> ownership record.
	// Ownership is assigned BEFORE the call awaits (at tool_execution_start,
	// and immediately when a joiner spawns during an active wait) — never
	// reactively when an exit lands.
	let activeControlCalls = new Map<string, ActiveControlCall>()
	// bash_control (~476 est) stays deferred
	// — registered but not advertised — until a background bash handle exists.
	// The visible `bash` description already names bash_control, so discovery
	// needs no extra text. Reveal is one-way: once a handle has existed, the
	// tool stays visible for the rest of the session.
	const visibility = createToolVisibility(pi)
	// Agent workers keep full bash_control visibility (subagent sessions run
	// long background tasks; deferral buys nothing there).
	const defer = !isAgentWorker()
	let bashControlRevealed = !defer
	// Termination state of the last assistant run: when the user cancelled
	// (or the provider errored), a later unattended exit must NOT restart
	// inference via triggerTurn. Cleared on the next agent_start (a new
	// user-initiated or continuation run).
	let runTerminated: "aborted" | "error" | undefined

	/** Reveal bash_control when the first background handle appears — one-way. */
	function revealBashControl(): void {
		if (bashControlRevealed) return
		bashControlRevealed = true
		visibility.enable([BASH_CONTROL_TOOL_NAME])
	}
	// Exits claimed by an in-flight control call: handle -> toolCallId.
	let claimedExits = new Map<string, string>()
	// Once-per-turn coalescing flag for concurrency reinforcement steers.
	let concurrencySteerSentThisTurn = false
	// Exits pending delivery in the current scheduling boundary. Flushed as
	// one coalesced message on the next microtask — prompt notification with
	// no multi-second delay and no recurring batching timer. Also read by the
	// completion continuation to suppress redundant reminders.
	let pendingExitDeliveries: string[] = []
	let exitDeliveryScheduled = false
	const terminalDetails = new Map<string, Record<string, unknown>>()
	let disposed = false

	pi.on("session_start", () => {
		terminalDetails.clear()
		trackedHandles = new Set()
		activeControlCalls = new Map()
		claimedExits = new Map()
		concurrencySteerSentThisTurn = false
		pendingExitDeliveries = []
		exitDeliveryScheduled = false
		runTerminated = undefined
		disposed = false
		pi.registerTool(createBashControlToolDefinition(getState))
		// Deferral vote AFTER registration: the tool exists, it's just hidden.
		// A resumed session that already revealed bash_control stays revealed
		// (only votes again when still deferred).
		if (!bashControlRevealed) visibility.disable([BASH_CONTROL_TOOL_NAME])
	})

	pi.on("agent_start", () => {
		// A new run (user prompt, continuation, or retry) ends the
		// cancelled-run state: inference may be woken by exits again.
		runTerminated = undefined
	})

	pi.on("turn_start", () => {
		concurrencySteerSentThisTurn = false
	})

	/** Assign ownership of `handle`'s terminal delivery to `callId`; first claim wins. */
	function claimExit(callId: string, handle: string, call: ActiveControlCall): void {
		call.owned.add(handle)
		if (!claimedExits.has(handle)) claimedExits.set(handle, callId)
	}

	/**
	 * Snapshot one terminal result for `handle`, record it in the shared
	 * terminal-delivery state, remove it from tracking, the cohort, and the
	 * registry, and return the shared formatted block. Idempotent:
	 * collection is claimed atomically on the registry (the one ownership
	 * table shared with the tool) BEFORE any await, so a racing exit
	 * watcher and a control-call sweep cannot both deliver the same
	 * terminal result. Used by unattended exits AND the
	 * tool_execution_end backstop — every terminal path formats through
	 * the same contract. The recorded outcome stays recoverable until an
	 * authoritative acknowledgement retires it.
	 */
	async function collectTerminalBlock(
		state: BashSessionState,
		handle: string,
		owner: TerminalOwner,
	): Promise<string | undefined> {
		const { registry, coordinator, delivery } = state
		// First collector wins: claim BEFORE awaiting. A handle claimed by an
		// in-flight bash_control call (or already collected) returns undefined.
		if (!registry.claimTerminal(handle)) return undefined
		if (!trackedHandles.delete(handle)) {
			// Not tracked anymore (its result was already delivered by a tool
			// result): release the claim and stay silent.
			registry.releaseTerminal(handle)
			return undefined
		}
		claimedExits.delete(handle)
		const entry = registry.getEntry(handle)
		if (!entry) {
			registry.releaseTerminal(handle)
			return undefined
		}
		const elapsed = elapsedSecondsSince(entry.spawnedAtMs)
		try {
			const final = registry.finalSnapshot(handle)
			// Snapshot the terminal payload BEFORE removing execution
			// resources, and record it in the shared delivery state: the
			// outcome remains pending (queryable/recoverable) until an
			// authoritative acknowledgement retires it.
			const payload = final
				? terminalResultText({
						handle,
						commandSummary: entry.commandSummary,
						elapsedSeconds: elapsed,
						state: final.state,
						exitCode: final.exitCode,
						reason: final.reason,
						deadlineSeconds: entry.deadlineSeconds,
						output: final.content,
						truncated: final.truncation?.truncated === true,
						fullOutputPath: final.fullOutputPath,
					})
				: undefined
			if (payload) delivery.record(handle, payload, owner)
			coordinator.handleRemoved(handle)
			await registry.remove(handle).catch(() => {})
			return payload
		} catch (err) {
			// A failed collection must not orphan the handle: release the
			// registry claim AND restore tracking. The exit watcher is
			// one-shot, so the restored tracking is what keeps the handle
			// accountable — the completion continuation still sees the
			// undelivered terminal result and a later bash_control call can
			// retry the collection (the claim is free).
			registry.releaseTerminal(handle)
			trackedHandles.add(handle)
			throw err
		}
	}

	/**
	 * Deliver an unattended exit immediately (snapshot → record → remove →
	 * notify). Exits landing in the same scheduling boundary coalesce into
	 * ONE message: the flush is a microtask, so no exit waits on a timer and
	 * an active bash_control wait is never postponed.
	 *
	 * The message is delivered as STEERING with typed identity details: the
	 * installed loop consumes steering at the next turn boundary (before the
	 * next assistant response), so delivery does not require a tool-free
	 * assistant stop. Outcomes already recorded in the delivery state (e.g.
	 * requeued by the failed-call backstop) reuse their recorded payload —
	 * no re-collection.
	 */
	function deliverUnattendedExit(state: BashSessionState, handle: string): void {
		pendingExitDeliveries.push(handle)
		if (exitDeliveryScheduled) return
		exitDeliveryScheduled = true
		void (async () => {
			try {
				// Same-boundary coalescing: let sibling exit callbacks (already
				// queued microtasks) join this batch before it is built.
				await Promise.resolve()
				exitDeliveryScheduled = false
				if (disposed) {
					pendingExitDeliveries = []
					return
				}
				// Stale registry (shutdown/replacement) — never notify a closing session.
				if (getState() !== state) {
					pendingExitDeliveries = []
					return
				}
				const batch = pendingExitDeliveries
				pendingExitDeliveries = []
				for (const pending of batch) {
					try {
						// A recorded pending (backstop requeue) reuses its payload;
						// a fresh exit is collected from the registry now.
						if (!state.delivery.getPending(pending)) {
							await collectTerminalBlock(state, pending, "automatic")
						}
					} catch (err) {
						// One handle's failed collection must not drop its coalesced
						// siblings from this message; the failed handle stays tracked
						// (restored by the collector) for the completion continuation.
						console.error("bash-background exit collection failed:", err)
					}
				}
				// Collection awaited registry cleanup: re-check the session
				// identity immediately before enqueueing — replacement or
				// shutdown during the async gap must never deliver a stale
				// result into the new session.
				if (disposed || getState() !== state) return
				// Atomic claim + enqueue: no awaits between markQueued and
				// sendMessage, and the pending identity is set BEFORE the call
				// because an idle-triggered send can start processing (and emit
				// its message_end acknowledgement) immediately.
				const deliveryId = randomUUID()
				const included: string[] = []
				const blocks: string[] = []
				for (const pending of batch) {
					if (state.delivery.markQueued(pending, deliveryId)) {
						included.push(pending)
						blocks.push(state.delivery.getPending(pending)?.payload ?? "")
					}
				}
				if (included.length === 0) return
				// Opportunistic compact statuses for the rest of the cohort (no
				// cursor advance — nothing was collected from them).
				const { registry, coordinator } = state
				const remaining = coordinator.handles()
				if (remaining.length > 0) {
					const statuses = remaining
						.map((h) => {
							const e = registry.getEntry(h)
							if (e?.state !== "running") return undefined
							return `- ${h}: ${e.commandSummary}; running ${elapsedSecondsSince(e.spawnedAtMs)}s`
						})
						.filter((line): line is string => line !== undefined)
					if (statuses.length > 0) {
						blocks.push(`Still running (${statuses.length}):\n${statuses.join("\n")}`)
					}
				}
				// A cancelled/errored run must not be restarted: keep the
				// payload in the conversation (appended, no inference wake)
				// instead of triggering a turn.
				const triggerTurn = runTerminated === undefined
				const details: BashExitMessageDetails = {
					deliveryId,
					sessionId: state.delivery.sessionId,
					handles: included,
				}
				try {
					pi.sendMessage(
						{
							customType: BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
							content: [{ type: "text", text: markHarnessSteer(blocks.join("\n\n")) }],
							display: false,
							details,
						},
						{ triggerTurn, deliverAs: "steer" },
					)
				} catch (err) {
					// A synchronous enqueue failure must not strand the outcomes
					// in `queued` (unrecoverable by inspection, wrongly suppressing
					// completion reminders): roll the batch back to `available` so
					// an explicit inspection can deliver them. No retry here — the
					// completion continuation keeps the handles accountable.
					state.delivery.releaseQueued(deliveryId)
					throw err
				}
				if (!triggerTurn) {
					// The installed session's no-trigger idle path
					// (`_appendCustomMessage`) commits the message to history
					// synchronously (agent state + session persistence) but does NOT
					// dispatch extension message_end handlers — it uses the listener
					// emit, not _emitExtensionEvent (verified against the installed
					// SDK). The append IS the authoritative commit for a session that
					// must not be woken, so the outcomes retire here rather than
					// waiting for an acknowledgement that will never fire. Leaving
					// them queued would report false pending status and could
					// duplicate the payload through a later abort-release recovery.
					state.delivery.acknowledgeAutomatic(deliveryId)
				}
			} catch (err: unknown) {
				console.error("bash-background exit delivery failed:", err)
			}
		})()
	}

	/** Watch a tracked handle for natural process exit and release it. */
	function armExitWatcher(handle: string): void {
		const state = getState()
		if (!state) return
		void state.registry
			.whenExited(handle)
			.then(() => {
				if (disposed) return
				// Stale registry (shutdown/replacement) — never notify a closing session.
				if (getState() !== state) return
				// Already resolved via a bash_control result — its own output
				// carried the final state, so no notification.
				if (!trackedHandles.has(handle)) return
				// An in-flight bash_control call owns this exit (ownership was
				// assigned before it awaited): stay silent. The call's
				// consolidated result is authoritative; tool_execution_end
				// backstops the case where it never delivered (e.g. an error
				// result).
				if (claimedExits.has(handle)) return
				deliverUnattendedExit(state, handle)
			})
			.catch((err: unknown) => {
				console.error("bash-background exit watcher failed:", err)
			})
	}

	function trackHandle(handle: string): void {
		if (trackedHandles.has(handle)) return
		trackedHandles.add(handle)
		// The first background handle makes bash_control relevant from this
		// turn on — one-way reveal (deferred until now to save tool-surface
		// tokens).
		revealBashControl()
		// A joiner spawning during an active wait is owned by that wait —
		// claim it now, before its exit can possibly arrive.
		for (const [callId, call] of activeControlCalls) {
			if (call.wait) claimExit(callId, handle, call)
		}
		armExitWatcher(handle)
	}

	// Pi drops details when execute throws; restore the terminal display update
	// through the supported result hook on both TUI and ACP.
	pi.on("tool_execution_update", (event) => {
		if (event.toolName !== "bash" && event.toolName !== BASH_CONTROL_TOOL_NAME) return
		const details: unknown = event.partialResult?.details
		if (!details || typeof details !== "object") return
		const value = details as Record<string, unknown>
		if (value.exited === true && value.display) terminalDetails.set(event.toolCallId, value)
	})

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash" && event.toolName !== BASH_CONTROL_TOOL_NAME) return
		const saved = terminalDetails.get(event.toolCallId)
		terminalDetails.delete(event.toolCallId)
		const restored = event.isError && saved ? { details: saved } : undefined
		const details = readDetails(restored?.details ?? event.details)
		const state = getState()

		if (event.toolName === "bash") {
			if (!details.handle) return restored
			if (details.handoff && !details.exited) {
				trackHandle(details.handle)
				return restored
			}
			if (details.exited) {
				trackedHandles.delete(details.handle)
				claimedExits.delete(details.handle)
			}
			return restored
		}

		// bash_control consolidated result: the tool_result event fires from
		// the installed runtime's afterToolCall hook, before the result
		// message is appended to the authoritative run context — the
		// acknowledged handles retire their pending terminal outcomes.
		for (const handle of details.exitedHandles ?? []) {
			trackedHandles.delete(handle)
			claimedExits.delete(handle)
		}
		state?.delivery.acknowledgeControl(details.exitedHandles ?? [])
		for (const handle of details.runningHandles ?? []) {
			trackHandle(handle)
		}
		// Missing details are ambiguous (transient error that never
		// observed the process state) — keep tracking rather than risk
		// forgetting a still-running process.
		return restored
	})

	pi.on("message_end", (event, _ctx: ExtensionContext) => {
		const message = event.message
		if (message?.role !== "custom") return undefined
		if (message.customType !== BASH_BACKGROUND_EXIT_MESSAGE_TYPE) return undefined
		const state = getState()
		if (!state) return undefined
		const details = readExitMessageDetails(message.details)
		// Session-identity guard: a message from a replaced/bash session
		// generation must not retire or mutate this session's state.
		if (!details || details.sessionId !== state.delivery.sessionId) return undefined
		const result = state.delivery.acknowledgeAutomatic(details.deliveryId)
		if (result === "delivered") return undefined
		// Superseded: the outcomes were already delivered authoritatively
		// (a control result claimed them after an abort-release, or this is
		// a late duplicate). Replace the stale message with a suppression
		// note so the terminal payload is never repeated — the installed
		// runtime applies message_end replacements in place for both the
		// run context and session persistence.
		const handles = details.handles.join(", ")
		return {
			message: {
				role: "custom",
				customType: BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
				content: [
					{
						type: "text",
						text: markHarnessSteer(
							`[Background bash exit notification for ${handles} was suppressed: its result was already delivered in a bash_control result.]`,
						),
					},
				],
				display: false,
				details: message.details,
				timestamp: message.timestamp,
			},
		}
	})

	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== BASH_CONTROL_TOOL_NAME) return
		const args = (event.args ?? undefined) as Record<string, unknown> | undefined
		if (!args || typeof args !== "object") return
		const wait = args.wait === true
		const call: ActiveControlCall = { wait, owned: new Set() }
		activeControlCalls.set(event.toolCallId, call)
		// Ownership is assigned before the call awaits. Every bash_control
		// call sweeps available terminal results for the whole cohort (waits
		// on settlement, immediate inspections right away), so each claims
		// every tracked handle — first claim wins when calls overlap, so a
		// rejected concurrent wait cannot steal an existing wait's claims.
		for (const handle of trackedHandles) claimExit(event.toolCallId, handle, call)
		if (Array.isArray(args.stop_handles)) {
			for (const h of args.stop_handles) {
				if (typeof h === "string" && h.length > 0) claimExit(event.toolCallId, h, call)
			}
		}
	})

	pi.on("tool_execution_end", (event) => {
		const call = activeControlCalls.get(event.toolCallId)
		if (!call) return
		activeControlCalls.delete(event.toolCallId)
		const state = getState()
		if (!state) return
		// Outcomes recorded by THIS call that its result never delivered
		// (it errored before carrying exitedHandles). Collected first so
		// the single ownership release covers every handle — releasing
		// inside the loop would flip later siblings' owner to `automatic`
		// before their own check, silently dropping them from recovery.
		const failedDeliveries: string[] = []
		for (const handle of call.owned) {
			if (claimedExits.get(handle) !== event.toolCallId) continue
			// A pending outcome recorded by THIS call was never delivered
			// (its result errored before carrying exitedHandlers): release
			// the failed claim below and requeue the recorded payload for the
			// automatic channel — no re-collection, no retry loop.
			const pending = state.delivery.getPending(handle)
			if (pending && pending.owner !== "automatic" && pending.owner.controlCallId === event.toolCallId) {
				failedDeliveries.push(handle)
				claimedExits.delete(handle)
				continue
			}
			if (pending) {
				claimedExits.delete(handle)
				continue
			}
			const entry = state.registry.getEntry(handle)
			if (!entry) {
				claimedExits.delete(handle)
				trackedHandles.delete(handle)
				continue
			}
			if (entry.state === "running") {
				// The call ended while the process is still alive (e.g. an
				// aborted wait): release the claim without delivering.
				claimedExits.delete(handle)
				continue
			}
			// Backstop: an exit this call claimed but never delivered (error
			// result, or an exit that settled after its sweep). The registry
			// still holds the handle, so the tool result did not carry it —
			// fire the notification path now so the exit is not silently dropped.
			deliverUnattendedExit(state, handle)
		}
		// Release the failed call's ownership once for ALL its recorded
		// outcomes, then requeue every one of them — they coalesce into one
		// identified notification.
		if (failedDeliveries.length > 0) {
			state.delivery.releaseControl(event.toolCallId)
			for (const handle of failedDeliveries) deliverUnattendedExit(state, handle)
		}
	})

	// Non-blocking: allow every tool call. When a tracked process runs and
	// the call is a known write/execute tool (per the shared taxonomy),
	// enqueue ONE concurrency steer per turn as reinforcement.
	pi.on("tool_call", (event) => {
		if (trackedHandles.size === 0) return { block: false }
		if (event.toolName === BASH_CONTROL_TOOL_NAME) return { block: false }
		const category = classifyTool(event.toolName)
		if (category !== "write" && category !== "execute") return { block: false }
		if (concurrencySteerSentThisTurn) return { block: false }
		concurrencySteerSentThisTurn = true
		pi.sendMessage(
			{
				customType: BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE,
				content: [
					{
						type: "text",
						text: markHarnessSteer(formatConcurrencySteer([...trackedHandles])),
					},
				],
				display: false,
			},
			{ deliverAs: "steer" },
		)
		return { block: false }
	})

	// Completion continuation: EVERY normal assistant stop with unresolved
	// managed work queues one consolidated follow-up. The queued follow-up
	// keeps the agent run unsettled (the agent loop drains follow-ups
	// before stopping), so settled success requires a disposition. A stable
	// handle set never suppresses the guard — repeated attempts each get a
	// continuation. When the only unresolved items are outcomes whose
	// identified steering notification is already queued, the reminder is
	// redundant (the notification itself continues the run) and is
	// suppressed. Terminal results whose notification is already queued
	// will resolve the state by themselves, so only genuinely unresolved
	// work produces a reminder.
	pi.on("turn_end", (event, _ctx: ExtensionContext) => {
		if (disposed) return
		const message = event.message
		if (message?.role !== "assistant") return
		const stopReason = (message as { stopReason?: unknown }).stopReason
		if (stopReason === "aborted" || stopReason === "error") {
			// Cancellation/termination is authoritative: no completion
			// continuation, and no inference restart for later exits. Kimchi's
			// TUI (Escape) and ACP (cancel) drop queued steering on abort, so
			// queued automatic outcomes are released back to recoverable
			// state — a later explicit inspection can deliver them. A late
			// arrival of a recovered outcome is suppressed via message_end
			// replacement, so recovery never duplicates the payload.
			runTerminated = stopReason
			getState()?.delivery.releaseAutomatic()
			return
		}
		if (stopReason !== "stop") return
		if (trackedHandles.size === 0 && !getState()?.delivery.hasPending()) return
		// Read current lifecycle state at the guard boundary: distinguish
		// live processes from terminal outcomes awaiting delivery.
		const state = getState()
		const running: string[] = []
		const awaitingDelivery = new Set<string>()
		for (const handle of trackedHandles) {
			const pending = state?.delivery.getPending(handle)
			if (pending) {
				awaitingDelivery.add(handle)
				continue
			}
			const entry = state?.registry.getEntry(handle)
			if (!state || !entry) {
				// Ambiguous (transient state): keep it accounted as live.
				running.push(handle)
			} else if (entry.state === "running") {
				running.push(handle)
			} else if (!pendingExitDeliveries.includes(handle)) {
				awaitingDelivery.add(handle)
			}
		}
		// Outcomes collected by the automatic channel (registry entry
		// already removed) stay accountable through the delivery state.
		for (const handle of state?.delivery.pendingHandles() ?? []) {
			awaitingDelivery.add(handle)
		}
		if (running.length === 0 && awaitingDelivery.size === 0) return
		// Redundancy suppression: when every unresolved outcome already has
		// an identified steering notification in progress (queued), the
		// notification itself continues the run — no reminder needed.
		const onlyQueuedNotifications =
			running.length === 0 &&
			[...awaitingDelivery].every((handle) => state?.delivery.getPending(handle)?.phase === "queued")
		if (onlyQueuedNotifications) return
		pi.sendMessage(
			{
				customType: BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE,
				content: [
					{
						type: "text",
						text: markHarnessSteer(formatCompletionContinuation(running, [...awaitingDelivery])),
					},
				],
				display: false,
			},
			{ deliverAs: "followUp" },
		)
	})

	pi.on("session_shutdown", () => {
		disposed = true
		terminalDetails.clear()
		trackedHandles.clear()
		activeControlCalls.clear()
		claimedExits.clear()
		pendingExitDeliveries = []
	})
}
