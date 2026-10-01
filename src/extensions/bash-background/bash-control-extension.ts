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
 * Delivery contract (exactly-once per terminal state):
 *
 *  - Every process retains a `whenExited` watcher. An exit is delivered
 *    immediately, never held for a periodic review. Exits already pending
 *    in the same scheduling boundary are coalesced into one message
 *    (microtask flush — no multi-second delay, no batching timer).
 *  - Exit of a handle owned by an active `bash_control` call (waits own
 *    every handle including joiners; inspections and stop-lists own the
 *    handles they may collect) is claimed silently — that call's
 *    consolidated tool result is the authoritative delivery. If the call
 *    ends without delivering it (its handle entries are still in the
 *    registry), the notification fires from `tool_execution_end`.
 *  - An unattended exit snapshots the terminal result, removes the
 *    handle, and calls `pi.sendMessage(..., { triggerTurn: true,
 *    deliverAs: "followUp" })` — `triggerTurn` wakes an idle agent;
 *    `followUp` queues the result at a safe boundary while streaming.
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
 * successfully while work lacks a disposition. User cancellation,
 * provider errors, token exhaustion, and shutdown never trigger it.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import { classifyTool } from "../permissions/taxonomy.js"
import { createToolVisibility } from "../prompt-construction/tool-visibility.js"
import { markHarnessSteer } from "../steer-marker.js"
import { BASH_CONTROL_TOOL_NAME, createBashControlToolDefinition } from "./bash-control-tool.js"
import { elapsedSecondsSince } from "./process-registry.js"
import { type BashSessionState, getSessionState } from "./session-registry.js"
import { terminalResultText } from "./status-text.js"

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
	let disposed = false

	pi.on("session_start", () => {
		trackedHandles = new Set()
		activeControlCalls = new Map()
		claimedExits = new Map()
		concurrencySteerSentThisTurn = false
		pendingExitDeliveries = []
		exitDeliveryScheduled = false
		disposed = false
		pi.registerTool(createBashControlToolDefinition(getState))
		// Deferral vote AFTER registration: the tool exists, it's just hidden.
		// A resumed session that already revealed bash_control stays revealed
		// (only votes again when still deferred).
		if (!bashControlRevealed) visibility.disable([BASH_CONTROL_TOOL_NAME])
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
	 * Snapshot one terminal result for `handle`, remove it from tracking,
	 * the cohort, and the registry, and return the shared formatted block.
	 * Idempotent: collection is claimed atomically on the registry (the one
	 * ownership table shared with the tool) BEFORE any await, so a racing
	 * exit watcher and a control-call sweep cannot both deliver the same
	 * terminal result. Used by unattended exits AND the tool_execution_end
	 * backstop — every terminal path formats through the same contract.
	 */
	async function collectTerminalBlock(state: BashSessionState, handle: string): Promise<string | undefined> {
		const { registry, coordinator } = state
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
			coordinator.handleRemoved(handle)
			await registry.remove(handle).catch(() => {})
			if (!final) return undefined
			return terminalResultText({
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
	 * Deliver an unattended exit immediately (snapshot → remove → notify).
	 * Exits landing in the same scheduling boundary coalesce into ONE
	 * message: the flush is a microtask, so no exit waits on a timer and an
	 * active bash_control wait is never postponed.
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
				const blocks: string[] = []
				for (const pending of batch) {
					try {
						const terminalText = await collectTerminalBlock(state, pending)
						if (terminalText) blocks.push(terminalText)
					} catch (err) {
						// One handle's failed collection must not drop its coalesced
						// siblings from this message; the failed handle stays tracked
						// (restored by the collector) for the completion continuation.
						console.error("bash-background exit collection failed:", err)
					}
				}
				if (blocks.length === 0) return
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
				pi.sendMessage(
					{
						customType: BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
						content: [{ type: "text", text: markHarnessSteer(blocks.join("\n\n")) }],
						display: false,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				)
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

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash" && event.toolName !== BASH_CONTROL_TOOL_NAME) return
		const details = readDetails(event.details)

		if (event.toolName === "bash") {
			if (!details.handle) return
			if (details.handoff && !details.exited) {
				trackHandle(details.handle)
				return
			}
			if (details.exited) {
				trackedHandles.delete(details.handle)
				claimedExits.delete(details.handle)
			}
			return
		}

		// bash_control consolidated result.
		for (const handle of details.exitedHandles ?? []) {
			trackedHandles.delete(handle)
			claimedExits.delete(handle)
		}
		for (const handle of details.runningHandles ?? []) {
			trackHandle(handle)
		}
		// Missing details are ambiguous (transient error that never
		// observed the process state) — keep tracking rather than risk
		// forgetting a still-running process.
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
		for (const handle of call.owned) {
			if (claimedExits.get(handle) !== event.toolCallId) continue
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
	// continuation. Terminal results whose notification is already queued
	// will resolve the state by themselves, so only genuinely unresolved
	// work produces a reminder.
	pi.on("turn_end", (event, _ctx: ExtensionContext) => {
		if (disposed) return
		if (trackedHandles.size === 0) return
		const message = event.message
		if (message?.role !== "assistant") return
		const stopReason = (message as { stopReason?: unknown }).stopReason
		if (stopReason !== "stop") return
		// Read current lifecycle state at the guard boundary: distinguish
		// live processes from terminal outcomes awaiting delivery.
		const state = getState()
		const running: string[] = []
		const awaitingDelivery: string[] = []
		for (const handle of trackedHandles) {
			const entry = state?.registry.getEntry(handle)
			if (!state || !entry || entry.state === "running") {
				running.push(handle)
			} else if (!pendingExitDeliveries.includes(handle)) {
				awaitingDelivery.push(handle)
			}
		}
		if (running.length === 0 && awaitingDelivery.length === 0) return
		pi.sendMessage(
			{
				customType: BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE,
				content: [
					{
						type: "text",
						text: markHarnessSteer(formatCompletionContinuation(running, awaitingDelivery)),
					},
				],
				display: false,
			},
			{ deliverAs: "followUp" },
		)
	})

	pi.on("session_shutdown", () => {
		disposed = true
		trackedHandles.clear()
		activeControlCalls.clear()
		claimedExits.clear()
		pendingExitDeliveries = []
	})
}
