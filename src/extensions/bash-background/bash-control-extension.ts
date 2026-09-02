/**
 * `bash_control` extension — cohort tracking, immediate exits, review delivery.
 *
 * Registers the `bash_control` companion tool (from `./bash-control-tool.js`)
 * and owns everything model-facing about a background cohort that is NOT a
 * direct tool call: immediate unattended-exit notifications, guaranteed
 * cohort-review delivery, the once-per-turn concurrency steer, and the
 * bounded completion guard. It NEVER hard-blocks other tool calls.
 *
 * Delivery contract (exactly-once per terminal state):
 *
 *  - Every process retains a `whenExited` watcher. An exit is delivered
 *    immediately, never held until a periodic review.
 *  - Exit of a handle owned by an active `bash_control` call (a `wait:
 *    true` cohort wait owns every handle; a stop-list call owns its stop
 *    handles) is claimed silently — that call's consolidated tool result
 *    is the authoritative delivery. If the call ends without delivering
 *    it (its handle entries are still in the registry), the notification
 *    fires from `tool_execution_end` instead.
 *  - An unattended exit snapshots the terminal result, removes the
 *    handle, and calls `pi.sendMessage(..., { triggerTurn: true,
 *    deliverAs: "followUp" })` — `triggerTurn` wakes an idle agent;
 *    `followUp` queues the result at a safe boundary while streaming.
 *
 * Review delivery (guaranteed, opportunistic): the review coordinator
 * fires `deliverReview` when a recurring review is due and no active
 * cohort wait claimed it. The extension then piggybacks on the current
 * turn (followUp, no trigger) or wakes the idle agent (followUp +
 * triggerTurn), so a forgotten process is always surfaced before the
 * safety limit without creating a dedicated inference per clock tick.
 *
 * Concurrency context: while any handle is tracked, write/execute tool
 * calls (shared permission taxonomy) receive at most one advisory steer
 * per turn — reinforcement, never a gate.
 *
 * Completion guard: a normal assistant completion (`stopReason ===
 * "stop"`) with tracked handles emits one hidden branded follow-up per
 * stable handle set, directing the model to a single batch wait or an
 * explicit stop. Managed background bash is killed at session shutdown,
 * so a forgotten process can invalidate a polished final response.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { classifyTool } from "../permissions/taxonomy.js"
import { markHarnessSteer } from "../steer-marker.js"
import { BASH_CONTROL_TOOL_NAME, createBashControlToolDefinition } from "./bash-control-tool.js"
import { elapsedSecondsSince } from "./process-registry.js"
import { type BashSessionState, getSessionState } from "./session-registry.js"
import { runningFactsText, terminalResultText } from "./status-text.js"

/** Custom message type for an unattended process-exit notification. */
export const BASH_BACKGROUND_EXIT_MESSAGE_TYPE = "bash-background-exit"
/** Custom message type for the once-per-turn concurrency reinforcement steer. */
export const BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE = "bash-background-concurrency"
/** Custom message type for the completion-guard follow-up. */
export const BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE = "bash-background-completion"
/** Custom message type for the guaranteed cohort-review delivery. */
export const BASH_BACKGROUND_REVIEW_MESSAGE_TYPE = "bash-background-review"

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

/** Stable key for the current set of tracked handles (sorted, comma-joined). */
function handleSetKey(handles: ReadonlySet<string>): string {
	return [...handles].sort().join(",")
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

/** Build the completion-guard follow-up text for a set of tracked handles. */
function formatCompletionReminder(handles: readonly string[]): string {
	const plural = handles.length !== 1
	const list = handles.join(", ")
	return (
		`Before finishing, resolve the background bash process${plural ? "es" : ""} still tracked: ${list}. ` +
		"Managed background bash is killed at session shutdown (unlike `daemon` processes), " +
		"so unfinished work or uncollected output may be lost. Do ONE of: " +
		"(1) call bash_control with wait: true to block for the next cohort event in a single batch; " +
		"(2) call bash_control with stop_handles for every process no longer needed; or " +
		"(3) briefly explain why the process is intentionally irrelevant to completion. " +
		"Do not silently end the turn while anything is still running."
	)
}

/** Ownership an in-flight bash_control call holds over exits. */
interface ActiveControlCall {
	/** wait: true — owns every cohort exit for the call's duration (joiners claimed on spawn). */
	wait: boolean
	/**
	 * Handles whose terminal results this call delivers: a wait claims the
	 * whole tracked cohort up front, a stop-list claims exactly its handles.
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
	// Exits claimed by an in-flight control call: handle -> toolCallId.
	let claimedExits = new Map<string, string>()
	// Once-per-turn coalescing flag for concurrency reinforcement steers.
	let concurrencySteerSentThisTurn = false
	// Stable handle-set keys that already received a completion reminder.
	let remindedHandleSetKeys = new Set<string>()
	// True between turn_start and turn_end — used to piggyback reviews.
	let turnActive = false
	let disposed = false

	pi.on("session_start", () => {
		trackedHandles = new Set()
		activeControlCalls = new Map()
		claimedExits = new Map()
		concurrencySteerSentThisTurn = false
		remindedHandleSetKeys = new Set()
		turnActive = false
		disposed = false
		pi.registerTool(createBashControlToolDefinition(getState))
		// Wire guaranteed review delivery through the session state so the
		// review coordinator (created by bashBackgroundExtension) can reach
		// us regardless of extension registration order.
		const state = getState()
		if (state) {
			state.deliverReview = () =>
				deliverCohortReview(state).catch((err: unknown) => {
					console.error("bash-background cohort review delivery failed:", err)
				})
		}
	})

	pi.on("turn_start", () => {
		concurrencySteerSentThisTurn = false
		turnActive = true
	})

	pi.on("turn_end", () => {
		turnActive = false
	})

	/** Assign ownership of `handle`'s terminal delivery to `callId`; first claim wins. */
	function claimExit(callId: string, handle: string, call: ActiveControlCall): void {
		call.owned.add(handle)
		if (!claimedExits.has(handle)) claimedExits.set(handle, callId)
	}

	/**
	 * Snapshot one terminal result for `handle`, remove it from tracking,
	 * the cohort, and the registry, and return the shared formatted block.
	 * Idempotent: a handle already removed from the registry cannot be
	 * delivered twice. Used by unattended exits AND due reviews — every
	 * terminal path formats through the same contract.
	 */
	async function collectTerminalBlock(state: BashSessionState, handle: string): Promise<string | undefined> {
		const { registry, coordinator } = state
		// First collector wins: the tracked set is the atomic exactly-once
		// guard. Run synchronously before any await so a racing exit watcher
		// and cohort review cannot both deliver the same terminal result.
		if (!trackedHandles.delete(handle)) return undefined
		claimedExits.delete(handle)
		const entry = registry.getEntry(handle)
		if (!entry) return undefined
		const elapsed = elapsedSecondsSince(entry.spawnedAtMs)
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
	}

	/**
	 * Deliver an unattended exit immediately (snapshot → remove → notify).
	 * Never held for a periodic review.
	 */
	function deliverUnattendedExit(state: BashSessionState, handle: string): void {
		void (async () => {
			const terminalText = await collectTerminalBlock(state, handle)
			if (!terminalText) return
			const { registry, coordinator } = state
			const blocks = [terminalText]
			// Opportunistic compact statuses for the rest of the cohort (no
			// cursor advance, no review-clock reset).
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
		})()
	}

	/**
	 * Guaranteed cohort-review delivery. Called by the review coordinator
	 * when a recurring review is due and no active `bash_control(wait:
	 * true)` claimed it. Piggybacks on an active turn (delivered at the
	 * next safe boundary) or wakes an idle agent exactly once.
	 */
	async function deliverCohortReview(state: BashSessionState): Promise<void> {
		if (disposed) return
		if (getState() !== state) return
		const { registry, coordinator } = state
		const handleList = coordinator.handles()
		if (handleList.length === 0) {
			coordinator.reviewDelivered()
			return
		}
		try {
			const blocks: string[] = [
				`Scheduled cohort review of ${handleList.length} background bash process${handleList.length === 1 ? "" : "es"}:`,
			]
			const pendingMarks: Array<[string, number]> = []
			for (const handle of handleList) {
				const entry = registry.getEntry(handle)
				if (!entry) continue
				if (entry.state !== "running") {
					// Terminal state: fold any undelivered terminal result into this
					// review. Exits claimed by an in-flight bash_control call belong
					// to that call's consolidated result and are left alone.
					if (claimedExits.has(handle)) continue
					const terminalText = await collectTerminalBlock(state, handle)
					if (terminalText) blocks.push(terminalText)
					continue
				}
				const incremental = registry.snapshotSince(handle)
				pendingMarks.push([handle, incremental.nextCursor])
				blocks.push(`${runningFactsText(entry, incremental, state.cwd)}\n\nNew/retained output follows.`)
				if (incremental.text.length > 0) blocks.push(incremental.text)
			}
			// The delivered cursor advances only after the review text is built.
			for (const [handle, cursor] of pendingMarks) registry.markDelivered(handle, cursor)
			blocks.push(
				"Processes continue by default. Stop unproductive ones with bash_control stop_handles; " +
					"if you have no other work until something changes, use ONE bash_control(wait: true) call. " +
					"A silent process is an observation, not proof of stalled work — check its output before concluding it is stuck.",
			)
			pi.sendMessage(
				{
					customType: BASH_BACKGROUND_REVIEW_MESSAGE_TYPE,
					content: [{ type: "text", text: markHarnessSteer(blocks.join("\n\n")) }],
					display: false,
				},
				// Piggyback on a natural boundary when a turn is active; wake an
				// idle agent rather than leave the cohort unattended.
				turnActive ? { deliverAs: "followUp" } : { triggerTurn: true, deliverAs: "followUp" },
			)
		} finally {
			// Always release the pending-review slot, even on failure — a
			// stuck slot would silently end all future cohort oversight.
			coordinator.reviewDelivered()
		}
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
		// Ownership is assigned before the call awaits: a wait claims the
		// whole tracked cohort; a stop-list claims exactly its handles.
		if (wait) {
			for (const handle of trackedHandles) claimExit(event.toolCallId, handle, call)
		}
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
				// The call ended while the process is still alive (e.g. a wait
				// resolved by a review): release the claim without delivering.
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

	// Completion guard: a normal assistant completion with tracked handles
	// emits one hidden branded follow-up per stable handle set.
	pi.on("turn_end", (event, _ctx: ExtensionContext) => {
		if (disposed) return
		if (trackedHandles.size === 0) return
		const message = event.message
		if (message?.role !== "assistant") return
		const stopReason = (message as { stopReason?: unknown }).stopReason
		if (stopReason !== "stop") return
		const key = handleSetKey(trackedHandles)
		if (remindedHandleSetKeys.has(key)) return
		remindedHandleSetKeys.add(key)
		pi.sendMessage(
			{
				customType: BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE,
				content: [
					{
						type: "text",
						text: markHarnessSteer(formatCompletionReminder([...trackedHandles])),
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
	})
}
