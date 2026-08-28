/**
 * `bash_control` extension — non-blocking live-process tracking.
 *
 * Registers the `bash_control` companion tool (from `./bash-control-tool.js`)
 * and tracks background bash processes for lifecycle notices and concurrency
 * context. Unlike the previous gate design, it NEVER hard-blocks other tool
 * calls while a process runs: the model is free to do independent work, and
 * the extension only steers (never blocks) when it detects a write/execute
 * tool that could conflict with a tracked process.
 *
 * Architecture (non-blocking model):
 *
 * The `bash` tool's `execute()` resolves at the first checkin (timer vs
 * process-exit race via `awaitCheckin`) with a handle, and tells the model
 * in its result text that other tools stay available. While any handle is
 * tracked, every tool call is ALLOWED; a `tool_call` handler inspects
 * write/execute tools via the shared `classifyTool()` taxonomy and enqueues
 * at most one concurrency steer per turn as reinforcement (coalesced like
 * `bash-tool-guard.ts`). `bash_control continue` still blocks until the next
 * checkin, naturally pacing output retrieval — but the model is never
 * forced to poll: it can read/edit/find/grep while the process runs.
 *
 * Why allow instead of block: the hard gate made `bash_control` the only
 * available tool after a checkin and forced the model back into blocking
 * polls, wasting wall-clock on long builds. Models need flexibility to
 * perform independent work, and the harness cannot prove every future
 * tool is safe — so the invariant is explained in the check-in result text
 * and a shared-taxonomy steer reinforces known write/execute calls without
 * blocking them.
 *
 * Tracking lifecycle:
 *  - A `bash` result with `details.handle` + `checkin: true` (process still
 *    running) adds the handle to the tracked set.
 *  - Each tracked handle gets an exit watcher (`registry.whenExited`). If the
 *    process exits on its own, the handle is released and a steer message
 *    tells the model the process finished (with its exit code) and that
 *    `bash_control` retrieves the final output. It never claims other tools
 *    were blocked or are now "available again".
 *  - A `bash_control` result that explicitly resolves the process
 *    (`exited: true` — stop, or continue observing an exit) removes the
 *    handle. Ambiguous results (`checkin: false` AND `exited: false`,
 *    e.g. an error that never observed the process state) do NOT drop
 *    tracking — the exit watcher or a later bash_control result resolves it.
 *    `bash_control` uses `throwIfTerminal` (throws on non-zero exit /
 *    deadline) and may never produce a resolved tool_result — the exit
 *    watcher covers that path too.
 *  - Ownership: an exit that settles while a `bash_control` call on the same
 *    handle is in flight (tracked via `tool_execution_start/end`) is NOT an
 *    unattended exit — the control call's own result is the authoritative
 *    notification, so the watcher claims it silently. If that call then
 *    throws before emitting a resolved result, `tool_execution_end`
 *    releases the handle without steering.
 *  - The watcher also captures the registry it subscribed to and bails when
 *    the accessor no longer returns it (session shutdown unpublishes the
 *    registry before draining it, so teardown never steers a closing
 *    session).
 *
 * Process tracking now exists for lifecycle notices and concurrency context,
 * not to close a gate. Human input is NOT a reason to forget a live child
 * process, so the previous "user input clears the gate" safety net is gone —
 * tracked handles survive user input.
 *
 * Completion guard: on a normal assistant completion (`stopReason ===
 * "stop"`) with at least one tracked handle, a hidden branded `followUp`
 * message names the handles and asks the model to retrieve output, stop an
 * unneeded process, or explain why it is intentionally irrelevant. Emitted
 * at most once per stable sorted handle set so it cannot create a loop.
 * Managed background bash is killed at session shutdown (unlike `daemon`
 * processes), so a forgotten process can invalidate an otherwise polished
 * final response — this bounded nudge catches that without hard-blocking.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { classifyTool } from "../permissions/taxonomy.js"
import { markHarnessSteer } from "../steer-marker.js"
import { BASH_CONTROL_TOOL_NAME, createBashControlToolDefinition } from "./bash-control-tool.js"
import type { ProcessRegistry } from "./process-registry.js"
import { getSessionRegistry } from "./session-registry.js"

/** Custom message type for the process-exit steer notice. */
export const BASH_BACKGROUND_EXIT_MESSAGE_TYPE = "bash-background-exit"
/** Custom message type for the once-per-turn concurrency reinforcement steer. */
export const BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE = "bash-background-concurrency"
/** Custom message type for the completion-guard follow-up. */
export const BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE = "bash-background-completion"

export interface BashControlExtensionOptions {
	/** Override the registry accessor (tests inject a controllable fake). */
	getRegistry?: () => ProcessRegistry | undefined
}

/** The subset of bash/bash_control result details this extension reads. */
interface BackgroundResultDetails {
	handle?: string
	checkin?: boolean
	exited?: boolean
}

/** Runtime-guarded read of tool_result `details` (typed `unknown` upstream). */
function readDetails(raw: unknown): BackgroundResultDetails {
	if (!raw || typeof raw !== "object") return {}
	const d = raw as Record<string, unknown>
	return {
		handle: typeof d.handle === "string" ? d.handle : undefined,
		checkin: d.checkin === true,
		exited: d.exited === true,
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
		"If this work overlaps, check the process status or stop it with bash_control first; " +
		"otherwise proceed. Other tools remain available while it runs."
	)
}

/** Build the completion-guard follow-up text for a set of tracked handles. */
function formatCompletionReminder(handles: readonly string[]): string {
	const plural = handles.length !== 1
	const list = handles.join(", ")
	return (
		`Before finishing, resolve the background bash process${plural ? "es" : ""} still tracked: ${list}. ` +
		"Managed background bash is killed at session shutdown (unlike `daemon` processes), " +
		"so unfinished work or uncollected output may be lost. Do one of: " +
		"(1) call bash_control with the handle to retrieve its status/final output; " +
		'(2) call bash_control with action "stop" if the process is no longer needed; or ' +
		"(3) briefly explain why the process is intentionally irrelevant to completion. " +
		"Do not silently end the turn while it is still running."
	)
}

export default function bashControlExtension(pi: ExtensionAPI, options?: BashControlExtensionOptions): void {
	const getRegistry = options?.getRegistry ?? getSessionRegistry
	// Tracked background handles awaiting final output retrieval. Non-blocking:
	// the extension steers on conflicts but never blocks other tools.
	let trackedHandles = new Set<string>()
	// bash_control executions currently in flight: toolCallId -> handle.
	// Used so the exit watcher can distinguish an unattended natural exit
	// (steer) from an exit an active control call is about to report (its
	// own result is authoritative — steering would be stale).
	let activeControlCalls = new Map<string, string>()
	// Exits claimed by an in-flight control call: handle -> toolCallId.
	// tool_execution_end releases these silently when the control call
	// finished without emitting a resolved result (throwIfTerminal path).
	let claimedExits = new Map<string, string>()
	// Once-per-turn coalescing flag for concurrency reinforcement steers,
	// rearmed on turn_start (matches bash-tool-guard.ts pattern).
	let concurrencySteerSentThisTurn = false
	// Stable handle-set keys that have already received a completion reminder,
	// so the same set cannot create a repeated continuation loop. A changed
	// set (new handle or one resolved) permits one new reminder.
	let remindedHandleSetKeys = new Set<string>()
	let disposed = false

	pi.on("session_start", () => {
		trackedHandles = new Set()
		activeControlCalls = new Map()
		claimedExits = new Map()
		concurrencySteerSentThisTurn = false
		remindedHandleSetKeys = new Set()
		disposed = false
		pi.registerTool(createBashControlToolDefinition())
	})

	pi.on("turn_start", () => {
		concurrencySteerSentThisTurn = false
	})

	/** toolCallId of the in-flight bash_control call for `handle`, if any. */
	function controlCallFor(handle: string): string | undefined {
		for (const [callId, h] of activeControlCalls) {
			if (h === handle) return callId
		}
		return undefined
	}

	/** Watch a tracked handle for natural process exit and release it. */
	function armExitWatcher(handle: string): void {
		const registry = getRegistry()
		if (!registry) return
		void registry
			.whenExited(handle)
			.then(({ exitCode }) => {
				if (disposed) return
				// The registry this watcher subscribed to was unpublished
				// (shutdown drains it, or a replacement session installed a new
				// one) — never steer into a closing/stale session.
				if (getRegistry() !== registry) return
				// Already resolved via bash_control — bash_control's own result
				// carried the final state, so no notice.
				if (!trackedHandles.has(handle)) return
				// An in-flight bash_control call owns this exit: its promise
				// settles before the call emits its result (kill/exit settles
				// execPromise first, so watcher reactions run first), and without
				// this guard we'd queue a stale steer about a handle the call is
				// about to resolve. Claim it silently; the tool_result /
				// tool_execution_end paths do the bookkeeping.
				const ownerCallId = controlCallFor(handle)
				if (ownerCallId) {
					claimedExits.set(handle, ownerCallId)
					return
				}
				trackedHandles.delete(handle)
				const codeText = exitCode !== null ? ` (exit code ${exitCode})` : ""
				const remaining = trackedHandles.size
				const tail =
					remaining > 0
						? ` ${remaining} background process${remaining === 1 ? "" : "es"} still tracked (${[...trackedHandles].join(", ")}).`
						: " No background processes remain tracked."
				pi.sendMessage(
					{
						customType: BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
						content: [
							{
								type: "text",
								text: markHarnessSteer(
									`Background bash process ${handle} exited on its own${codeText}. Call bash_control with this handle to retrieve the final output.${tail}`,
								),
							},
						],
						display: false,
					},
					{ deliverAs: "steer" },
				)
			})
			.catch((err: unknown) => {
				// whenExited is backed by an error-wrapped promise and never
				// rejects today; log defensively so a future regression there
				// can't drop tracking silently.
				console.error("bash-background exit watcher failed:", err)
			})
	}

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash" && event.toolName !== BASH_CONTROL_TOOL_NAME) return
		const details = readDetails(event.details)
		if (!details.handle) return
		if (details.checkin && !details.exited) {
			// Mid-run checkin (from bash's first result, or a bash_control
			// continue that found the process still running): track the handle.
			// Arm the watcher only when the handle is new — a repeat checkin
			// for the same handle must not arm duplicates.
			if (!trackedHandles.has(details.handle)) {
				trackedHandles.add(details.handle)
				armExitWatcher(details.handle)
			}
			return
		}
		// Explicit resolution (stop, or continue that observed the exit):
		// the handle is no longer tracked. Deleting an unlisted handle is a
		// no-op (e.g. bash_control's graceful "unknown handle" error result).
		if (details.exited) {
			trackedHandles.delete(details.handle)
			claimedExits.delete(details.handle)
		}
		// checkin:false + exited:false is ambiguous (transient error that
		// never observed the process state) — keep tracking rather than risk
		// forgetting a still-running process.
	})

	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== BASH_CONTROL_TOOL_NAME) return
		const args = (event.args ?? undefined) as Record<string, unknown> | undefined
		if (!args || typeof args !== "object") return
		if (typeof args.handle === "string") activeControlCalls.set(event.toolCallId, args.handle)
	})

	pi.on("tool_execution_end", (event) => {
		const handle = activeControlCalls.get(event.toolCallId)
		if (handle === undefined) return
		activeControlCalls.delete(event.toolCallId)
		// This call claimed the exit (watcher deferred to it) but no resolved
		// tool_result released the handle — the throwIfTerminal path, where
		// the call removes the registry entry and throws. Its error result
		// still carried the outcome to the model, so release silently.
		if (claimedExits.get(handle) === event.toolCallId) {
			claimedExits.delete(handle)
			trackedHandles.delete(handle)
		}
	})

	// Non-blocking: allow every tool call. When a tracked process runs and
	// the call is a known write/execute tool (per the shared taxonomy),
	// enqueue ONE concurrency steer per turn as reinforcement. The call is
	// still allowed to proceed — this is advisory, not a gate.
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
	// emits one hidden branded follow-up per stable handle set, asking the
	// model to retrieve output, stop an unneeded process, or explain why it
	// is intentionally irrelevant. Does not fire on toolUse turns, errors,
	// aborts, during shutdown, or when no handles are tracked.
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
