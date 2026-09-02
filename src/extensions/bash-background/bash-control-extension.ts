/**
 * `bash_control` extension.
 *
 * Registers the `bash_control` companion tool (from `./bash-control-tool.js`)
 * and gates tool calls while a background bash process awaits a continue/stop
 * decision.
 *
 * Architecture (blocking model):
 *
 * The `bash` tool's `execute()` blocks until the first checkin (timer vs
 * process exit race via `awaitCheckin`), then resolves with a handle. While
 * any handle is pending, every `tool_call` except `bash_control` is HARD
 * BLOCKED with a steering reason that names the pending handle(s) and the
 * remedy — so the agent is forced to respond with a control decision, but
 * every rejection tells it exactly why and how to proceed. `bash_control
 * continue` also blocks until the next checkin, naturally pacing the loop —
 * no `terminate`, no timer nudge, no reliance on the event loop staying
 * alive. Works in both interactive and one-shot (`-p`) modes.
 *
 * Why block instead of hiding tools: an earlier version hid every active
 * tool except `bash_control` (vote-based visibility). Models called the
 * hidden tools from conversation context anyway and upstream answered with a
 * bare "Tool X not found" — no state, no remedy — which agents diagnosed as
 * a tool outage and retried for dozens of turns (one session burned ~76
 * rejected calls / ~1 hour before a human intervened). Blocking keeps the
 * tool list stable and makes each rejection self-explanatory.
 *
 * Gate lifecycle:
 *  - A `bash` result with `details.handle` + `checkin: true` (process still
 *    running) adds the handle to the pending set; the gate closes while the
 *    set is non-empty.
 *  - Each pending handle gets an exit watcher (`registry.whenExited`). If the
 *    process exits on its own, the handle is released immediately and a
 *    steer message tells the model the process finished (with its exit
 *    code) — closing the forever-locked gap where a natural exit while the
 *    gate was closed left no event to reopen it.
 *  - A `bash_control` result that explicitly resolves the process
 *    (`exited: true` — stop, or continue observing an exit) removes the
 *    handle. Ambiguous results (`checkin: false` AND `exited: false`,
 *    e.g. an error that never observed the process state) do NOT open the
 *    gate — the exit watcher or a later bash_control result resolves it.
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
 * Safety net: user `input` clears the pending set so a stuck gate can't lock
 * the agent out when a human takes over.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { markHarnessSteer } from "../steer-marker.js"
import { BASH_CONTROL_TOOL_NAME, createBashControlToolDefinition } from "./bash-control-tool.js"
import type { ProcessRegistry } from "./process-registry.js"
import { getSessionRegistry } from "./session-registry.js"

/** Custom message type for the process-exit steer notice. */
export const BASH_BACKGROUND_EXIT_MESSAGE_TYPE = "bash-background-exit"

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

/**
 * Block reason returned for non-bash_control tool calls while the gate is
 * closed. Names the exact remedy so the model pivots immediately instead of
 * diagnosing an outage and retrying (the failure mode this replaces).
 */
export function formatGateBlockReason(toolName: string, handles: readonly string[]): string {
	const plural = handles.length !== 1
	const list = handles.join(", ")
	return (
		`Blocked ${toolName}: background bash process${plural ? "es" : ""} awaiting a continue/stop decision: ${list}. ` +
		`Call the bash_control tool with one of these handles (action "continue" to keep it running, or "stop" to kill it). ` +
		`Other tools stay blocked until ${plural ? "all pending processes are" : "the process is"} resolved or exits on its own.`
	)
}

export default function bashControlExtension(pi: ExtensionAPI, options?: BashControlExtensionOptions): void {
	const getRegistry = options?.getRegistry ?? getSessionRegistry
	// Handles awaiting a continue/stop decision. The gate is closed while this
	// set is non-empty. Per-session: rebuilt on session_start (this factory
	// runs once per session, but resume/fork re-enters session_start).
	let pendingHandles = new Set<string>()
	// bash_control executions currently in flight: toolCallId -> handle.
	// Used so the exit watcher can distinguish an unattended natural exit
	// (steer) from an exit an active control call is about to report (its
	// own result is authoritative — steering would be stale).
	let activeControlCalls = new Map<string, string>()
	// Exits claimed by an in-flight control call: handle -> toolCallId.
	// tool_execution_end releases these silently when the control call
	// finished without emitting a resolved result (throwIfTerminal path).
	let claimedExits = new Map<string, string>()
	let disposed = false

	pi.on("session_start", () => {
		pendingHandles = new Set()
		activeControlCalls = new Map()
		claimedExits = new Map()
		disposed = false
		pi.registerTool(createBashControlToolDefinition())
	})

	/** toolCallId of the in-flight bash_control call for `handle`, if any. */
	function controlCallFor(handle: string): string | undefined {
		for (const [callId, h] of activeControlCalls) {
			if (h === handle) return callId
		}
		return undefined
	}

	/** Watch a pending handle for natural process exit and release the gate. */
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
				// Already resolved via bash_control or the input safety net —
				// bash_control's own result carried the final state, so no notice.
				if (!pendingHandles.has(handle)) return
				// An in-flight bash_control call owns this exit: its promise
				// settles before the call emits its result (kill/exit settles
				// execPromise first, so watcher reactions run first), and without
				// this guard we'd queue a stale "call bash_control" steer about a
				// handle the call is about to resolve. Claim it silently; the
				// tool_result / tool_execution_end paths do the bookkeeping.
				const ownerCallId = controlCallFor(handle)
				if (ownerCallId) {
					claimedExits.set(handle, ownerCallId)
					return
				}
				pendingHandles.delete(handle)
				const codeText = exitCode !== null ? ` (exit code ${exitCode})` : ""
				const stillPending = pendingHandles.size
				pi.sendMessage(
					{
						customType: BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
						content: [
							{
								type: "text",
								text: markHarnessSteer(
									`[Background bash process ${handle} exited on its own${codeText}. Call bash_control with this handle to retrieve the final output.${stillPending > 0 ? ` ${stillPending} background process${stillPending === 1 ? "" : "es"} still pending — only bash_control is available until ${stillPending === 1 ? "it resolves" : "they resolve"}.` : " No background processes remain pending — all tools are available again."}]`,
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
				// can't take the gate down silently.
				console.error("bash-background exit watcher failed:", err)
			})
	}

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash" && event.toolName !== BASH_CONTROL_TOOL_NAME) return
		const details = readDetails(event.details)
		if (!details.handle) return
		if (details.checkin && !details.exited) {
			// Mid-run checkin (from bash's first result, or a bash_control
			// continue that found the process still running): handle awaits
			// a decision. Arm the watcher only when the handle is new — a
			// repeat checkin for the same handle must not arm duplicates.
			if (!pendingHandles.has(details.handle)) {
				pendingHandles.add(details.handle)
				armExitWatcher(details.handle)
			}
			return
		}
		// Explicit resolution (stop, or continue that observed the exit):
		// the handle no longer pends. Deleting an unlisted handle is a no-op
		// (e.g. bash_control's graceful "unknown handle" error result).
		if (details.exited) {
			pendingHandles.delete(details.handle)
			claimedExits.delete(details.handle)
		}
		// checkin:false + exited:false is ambiguous (transient error that
		// never observed the process state) — keep the gate closed rather
		// than risk opening it while the process still runs.
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
			pendingHandles.delete(handle)
		}
	})

	pi.on("tool_call", (event) => {
		if (pendingHandles.size === 0) return { block: false }
		if (event.toolName === BASH_CONTROL_TOOL_NAME) return { block: false }
		return {
			block: true,
			reason: formatGateBlockReason(event.toolName, [...pendingHandles]),
		}
	})

	// Safety net: clear the gate on user input so an interrupted turn can't
	// lock the agent out of its tools. Extension-sourced inputs don't count —
	// only a human taking over releases the gate early. Processes keep running
	// under their registry deadlines; bash_control still resolves them normally.
	pi.on("input", (event) => {
		if (event.source === "extension") return
		pendingHandles.clear()
		claimedExits.clear()
	})

	pi.on("session_shutdown", () => {
		disposed = true
		pendingHandles.clear()
		activeControlCalls.clear()
		claimedExits.clear()
	})
}
