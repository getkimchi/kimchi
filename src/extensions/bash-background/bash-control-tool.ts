/**
 * `bash_control` companion tool — cohort inspection, stopping, bounded waits.
 *
 * Continuation is the default: the agent names only the processes it
 * wants to stop, inspects when there is a reason, and blocks with a
 * bounded wait when it has nothing else to do:
 *
 *  - `stop_handles`: kill these handles (one or many) and include each
 *    final result in the consolidated response. Unknown handles are
 *    reported individually without discarding valid actions. All
 *    unlisted live handles KEEP RUNNING.
 *  - `wait: false`: apply stops and return immediately — an inspection
 *    of every tracked process: terminal results that are available are
 *    delivered, and each running process reports runtime, output age,
 *    checkpoint streak, and remaining safety budget.
 *  - `wait: true`: apply stops, then block until the first process exit
 *    in the cohort (joiners included), pending automatic delivery, or a
 *    bounded checkpoint — `waitSeconds` seconds when provided, 300s (five minutes) by
 *    default, capped at 600s (ten minutes). At most one cohort wait may
 *    be active per session; a second concurrent wait is rejected with a
 *    clear error.
 *
 * Inputs are validated (and durations capped) at execution time too, so
 * direct calls and replay paths that bypass schema validation cannot
 * mutate state with invalid parameters. `waitSeconds` with `wait: false`
 * is rejected before any stop is applied — a duration that cannot affect
 * the operation is never silently accepted.
 *
 * Aborting a wait cancels only the wait — it never kills the cohort.
 * Batch results mark each process failure explicitly instead of throwing,
 * so one failed process cannot discard sibling statuses. The wait
 * duration never extends a process's runtime limit.
 *
 * Legacy `{ extend_seconds, checkin_interval }` timing fields (resumed
 * sessions, ACP replays) are accepted as deprecated, ignored compatibility
 * inputs. Legacy `handle`/`action` payloads are NOT translated — they
 * degrade to an immediate inspection (harness-owned cadence and
 * deadlines).
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { type Static, Type } from "typebox"
import { elapsedSecondsSince } from "./process-registry.js"
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "./review-coordinator.js"
import { type BashSessionState, getSessionState } from "./session-registry.js"
import {
	checkpointGuidanceText,
	emptyWaitText,
	inspectionHeaderText,
	pendingDeliveryText,
	processEvidenceText,
	terminalResultText,
	unseenOutputText,
	waitCheckpointHeaderText,
} from "./status-text.js"

const bashControlSchema = Type.Object({
	stop_handles: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Handles of background bash processes to stop now. All unlisted live handles continue running. Their final results are included in this call's response.",
		}),
	),
	wait: Type.Boolean({
		description:
			"true: after applying any stops, block until the first cohort process exit, pending automatic delivery, or a bounded checkpoint, and return one consolidated snapshot. Use only when you have no independent work to do. false: apply stops and return an immediate inspection of every tracked process; processes continue by default and their exit results arrive automatically.",
	}),
	waitSeconds: Type.Optional(
		Type.Number({
			description: `Optional wait duration in seconds for wait: true. Omitted: ${DEFAULT_WAIT_SECONDS}s (five minutes). Requests above ${MAX_WAIT_SECONDS}s are capped at ${MAX_WAIT_SECONDS}s. The wait returns earlier when a process exits or an automatic exit result is pending delivery. This duration never extends any process's runtime limit.`,
		}),
	),
	/** @deprecated Ignored. Deadlines are harness-owned; retained one release so resumed sessions and ACP replays carrying legacy timing payloads still validate. */
	extend_seconds: Type.Optional(Type.Number()),
	/** @deprecated Ignored. Wait checkpoints are requested through waitSeconds; retained for the same compatibility reason. */
	checkin_interval: Type.Optional(Type.Number()),
})

export type BashControlInput = Static<typeof bashControlSchema>

/** What kind of `bash_control` response this is / what ended a wait. */
export type BashControlEvent = "inspection" | "exit" | "checkpoint" | "aborted" | "empty"

/** Details returned by bash_control (read by the bash-control extension). */
export interface BashControlDetails {
	/** Handles whose terminal results this result delivers (stop or observed exit). */
	exitedHandles?: string[]
	/** Handles that remain running after this result (snapshot delivered). */
	runningHandles?: string[]
	/** True when an explicit wait was cancelled by abort (processes unaffected). */
	aborted?: boolean
	/** Freeform failure marker for error results ("no-registry", "invalid-params", …). */
	reason?: string
	/** What kind of response this is (inspection) or what ended the wait (exit/checkpoint/aborted/empty). */
	event?: BashControlEvent
	/** Handles whose terminal results are queued for automatic delivery and NOT included in this result. */
	pendingHandles?: string[]
	/** Effective bounded wait duration (seconds) used by a wait: true call. */
	effectiveWaitSeconds?: number
	/** Actual time spent waiting (seconds), measured — never the requested duration. */
	waitedSeconds?: number
}

export const BASH_CONTROL_TOOL_NAME = "bash_control"

export const BASH_CONTROL_TOOL_DESCRIPTION = `Control background bash processes started by the \`bash\` tool.

Background processes continue by default: each process's final exit result is delivered to you automatically — it reaches the conversation at the next turn boundary while you keep working, or immediately when the agent is idle. You do NOT need to call this tool to keep a process alive or to collect its output.

- \`wait: false\`: inspect every tracked process now — running runtime, output age, and new output — without stopping anything. Use it before dependent work when you need current status. Terminal results that already ended are delivered in the response; results already queued for automatic delivery are reported as pending.
- \`wait: true\`: block until the first cohort exit or a bounded checkpoint (${DEFAULT_WAIT_SECONDS}s by default, at most ${MAX_WAIT_SECONDS}s; set an earlier one with \`waitSeconds\`), then receive one consolidated snapshot with evidence. Use this ONLY when you have no independent work to do — never to poll a single process. Only one wait can be active at a time. When an exit result is queued for automatic delivery, the wait returns pending status immediately so delivery can proceed, even while other processes run. When every process has already ended, the wait returns immediately with the outcomes — pending or delivered — instead of starting a timer; a genuinely empty session answers at once with no wait at all.
- \`stop_handles\`: stop the named processes now and get their final results in one response. Every unlisted handle keeps running.

At a checkpoint, compare each process's runtime with its expected duration and decide: wait again, investigate, or stop. A checkpoint does not prove a hang — silence alone does not establish a stall.`

interface NormalizedParams {
	stopHandles: string[]
	wait: boolean
	/** Raw requested wait duration exactly as supplied (validated at execution time). */
	rawWaitSeconds: unknown
}

/**
 * Normalize stop handles (drop empty values, deduplicate preserving first
 * occurrence order) and read `wait`. The raw `waitSeconds` value is
 * preserved as-is — schema validation normally guarantees a number, but
 * direct calls from resumed sessions and ACP replays bypass it, so every
 * shape decision happens at execution-time validation, before any
 * mutation. Only `undefined` means "omitted"; `null` and every other
 * non-number shape are supplied invalid values and are rejected.
 */
function normalizeParams(params: BashControlInput): NormalizedParams {
	const stopHandles: string[] = []
	for (const handle of params.stop_handles ?? []) {
		if (typeof handle === "string" && handle.length > 0 && !stopHandles.includes(handle)) stopHandles.push(handle)
	}
	const rawWaitSeconds: unknown = params.waitSeconds
	// wait is required by the schema; `=== true` keeps direct (unvalidated)
	// execute calls deterministic too.
	return { stopHandles, wait: params.wait === true, rawWaitSeconds }
}

function errorResult(
	message: string,
	reason: string,
): {
	content: { type: "text"; text: string }[]
	details: BashControlDetails
} {
	return { content: [{ type: "text", text: `Error: ${message}` }], details: { reason } }
}

/**
 * Format one terminal result block for `handle` and retire it everywhere.
 *
 * Delivery-state-aware: an outcome already recorded in the shared
 * terminal-delivery state (its registry entry was removed by the
 * automatic collector) is resolved from that state — an `available`
 * outcome is claimed for THIS call and delivered through its result; a
 * `queued` outcome belongs irreversibly to the automatic notification,
 * so only its pending status is reported (the payload is never
 * duplicated). Only a handle with a live registry entry takes the
 * collect-and-remove path below.
 */
async function collectTerminalResult(
	state: BashSessionState,
	handle: string,
	prefix?: string,
	toolCallId?: string,
): Promise<{ text: string; resolved: boolean; pending?: boolean }> {
	const { registry, coordinator, delivery } = state
	// Recorded outcome: the process ended and was collected already.
	const pending = delivery.getPending(handle)
	if (pending) {
		if (pending.phase === "available") {
			// Already claimed by THIS call (e.g. re-listed after a stop): the
			// recorded payload is this result's content.
			const ownClaim =
				pending.owner !== "automatic" && toolCallId !== undefined && pending.owner.controlCallId === toolCallId
			const claimed = ownClaim || (toolCallId !== undefined && delivery.claimControl(handle, toolCallId))
			if (claimed) {
				return { text: prefix ? `${prefix}\n${pending.payload}` : pending.payload, resolved: true }
			}
			if (pending.owner !== "automatic") {
				return {
					text: `${prefix ?? ""}Handle '${handle}' is already being resolved by another call; its result is being delivered there.`,
					resolved: false,
				}
			}
			// The automatic channel enqueued between the check and the claim:
			// fall through to the pending report.
		}
		return {
			text: `${prefix ?? ""}${pendingDeliveryText(handle)}`,
			resolved: false,
			pending: true,
		}
	}
	const entry = registry.getEntry(handle)
	if (!entry) {
		return {
			text:
				`${prefix ?? ""}Unknown handle '${handle}' in this session. ` +
				"No live process, pending exit result, or queued delivery is associated with it — it may never have existed here, " +
				"or its outcome was already delivered earlier in this conversation.",
			resolved: false,
		}
	}
	// Atomically claim collection BEFORE awaiting anything: parallel control
	// calls (and racing unattended-exit notifications) must not both capture
	// this terminal result. First claim wins; the claim clears when the
	// entry is removed below.
	if (!registry.claimTerminal(handle)) {
		return {
			text: `${prefix ?? ""}Handle '${handle}' is already being resolved by another call; its result is being delivered there.`,
			resolved: false,
		}
	}
	const elapsed = elapsedSecondsSince(entry.spawnedAtMs)
	try {
		await registry.kill(handle).catch(() => {})
		const final = registry.finalSnapshot(handle)
		const text = final
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
			: `${prefix ?? ""}Process ${handle} ended before its result could be captured.`
		// Record the outcome in the shared delivery state (control-owned:
		// this result is the authoritative carrier) BEFORE removing the
		// execution resources, so it stays recoverable until acknowledged.
		coordinator.handleRemoved(handle)
		if (final) {
			delivery.record(handle, text, toolCallId ? { controlCallId: toolCallId } : "automatic")
		}
		await registry.remove(handle).catch(() => {})
		if (!final) {
			return { text, resolved: false }
		}
		return { text: prefix ? `${prefix}\n${text}` : text, resolved: true }
	} catch (err) {
		// A failed collection must not leave the terminal claim locked:
		// release it so the extension's fallback delivery or a later call
		// can still acquire it and deliver the result.
		registry.releaseTerminal(handle)
		throw err
	}
}

/** How the consolidated collection routine should head its running section. */
type SnapshotMode =
	| { kind: "inspection" }
	| { kind: "exit"; handle: string }
	| { kind: "checkpoint"; requestedSeconds: number; waitedSeconds: number }

interface CohortSnapshot {
	/** Terminal result blocks collected by this sweep. */
	terminalBlocks: string[]
	/** Running-evidence blocks (identity, runtime, output, streaks). */
	runningBlocks: string[]
	/** Pending-delivery status lines (outcomes owned by the automatic channel). */
	pendingBlocks: string[]
	exitedHandles: string[]
	/** Handles whose terminal results are queued for automatic delivery. */
	pendingHandles: string[]
	runningHandles: string[]
}

/**
 * Shared collection routine for inspection, checkpoint, and exit
 * responses: sweeps terminal outcomes (delivering their results exactly
 * once through this response), captures running snapshots with evidence,
 * and advances delivered cursors only for output actually included here.
 * Terminal outcomes already recorded in the shared delivery state are
 * swept FIRST: an available outcome is claimed for this call and
 * delivered; a queued outcome is reported as pending (the automatic
 * notification owns the payload).
 */
async function collectCohortSnapshot(
	state: BashSessionState,
	opts: { settlementCheckpoint?: boolean; toolCallId?: string } = {},
): Promise<CohortSnapshot> {
	const { registry, coordinator, delivery } = state
	const snapshot: CohortSnapshot = {
		terminalBlocks: [],
		runningBlocks: [],
		pendingBlocks: [],
		exitedHandles: [],
		pendingHandles: [],
		runningHandles: [],
	}

	// Pending-delivery sweep: every recorded terminal outcome whose
	// registry entry was already removed (collected by the automatic
	// channel, or released after a cancelled run). A handle delivered
	// earlier in this same call (stop list) is not repeated.
	for (const handle of delivery.pendingHandles()) {
		if (snapshot.exitedHandles.includes(handle)) continue
		const recorded = delivery.getPending(handle)
		// A pending claimed by THIS call (stop list) was already delivered
		// through this result; re-listing it would duplicate the payload.
		if (recorded && recorded.owner !== "automatic" && recorded.owner.controlCallId === opts.toolCallId) {
			continue
		}
		const result = await collectTerminalResult(state, handle, undefined, opts.toolCallId)
		if (result.resolved) {
			snapshot.terminalBlocks.push(result.text)
			snapshot.exitedHandles.push(handle)
		} else if (result.pending) {
			snapshot.pendingBlocks.push(result.text)
			snapshot.pendingHandles.push(handle)
		}
	}

	// Terminal sweep: every cohort handle that reached a terminal state —
	// the event's own exit plus any siblings that settled in the same
	// window (safety limit, a parallel stop, …). First collector wins, so
	// terminal results are delivered exactly once.
	for (const handle of [...coordinator.handles()]) {
		const entry = registry.getEntry(handle)
		if (!entry || entry.state === "running") continue
		const result = await collectTerminalResult(state, handle, undefined, opts.toolCallId)
		snapshot.terminalBlocks.push(result.text)
		if (result.resolved) snapshot.exitedHandles.push(handle)
		else if (result.pending) {
			snapshot.pendingBlocks.push(result.text)
			snapshot.pendingHandles.push(handle)
		}
	}

	// Running evidence: identity, runtime, output age, checkpoint streak,
	// remaining safety budget, and unseen output. The streak evidence counts
	// THIS checkpoint whenever the wait settled on its timer — even when
	// requested stops or racing exits also delivered terminal results, the
	// survivors' history follows the event that ended the wait. The
	// delivered cursor advances only after this response is built.
	const countThisCheckpoint = opts.settlementCheckpoint === true
	const pendingMarks: Array<[string, number]> = []
	for (const handle of coordinator.handles()) {
		const entry = registry.getEntry(handle)
		if (entry?.state !== "running") continue
		snapshot.runningHandles.push(handle)
		const incremental = registry.snapshotSince(handle)
		pendingMarks.push([handle, incremental.nextCursor])
		snapshot.runningBlocks.push(
			processEvidenceText({
				handle,
				commandSummary: entry.commandSummary,
				runtimeSeconds: elapsedSecondsSince(entry.spawnedAtMs),
				lastOutputAgeSeconds:
					entry.lastOutputAtMs === undefined
						? undefined
						: Math.max(0, Math.floor((Date.now() - entry.lastOutputAtMs) / 1000)),
				consecutiveCheckpoints: coordinator.getCheckpointStreak(handle) + (countThisCheckpoint ? 1 : 0),
				safetyRemainingSeconds: Math.max(0, Math.ceil((entry.deadlineMs - Date.now()) / 1000)),
				sessionCwd: state.cwd,
				cwd: entry.cwd,
			}),
			unseenOutputText(incremental),
		)
	}
	for (const [handle, cursor] of pendingMarks) registry.markDelivered(handle, cursor)
	return snapshot
}

/** Assemble the final text of an inspection/checkpoint/exit response. */
function snapshotBlocks(mode: SnapshotMode, snapshot: CohortSnapshot): string[] {
	const blocks: string[] = []
	if (mode.kind === "checkpoint") {
		blocks.push(waitCheckpointHeaderText(mode.requestedSeconds, mode.waitedSeconds))
	} else if (mode.kind === "exit") {
		blocks.push(`Cohort event: process exited (${mode.handle}).`)
	}
	blocks.push(...snapshot.terminalBlocks)
	if (snapshot.pendingBlocks.length > 0) {
		blocks.push(`Awaiting automatic delivery (${snapshot.pendingHandles.length}):`, ...snapshot.pendingBlocks)
	}
	if (snapshot.runningHandles.length > 0) {
		if (mode.kind === "inspection") blocks.push(inspectionHeaderText(snapshot.runningHandles.length))
		else if (mode.kind === "exit") blocks.push(`Still running (${snapshot.runningHandles.length}):`)
		blocks.push(...snapshot.runningBlocks)
	}
	if (mode.kind === "checkpoint" && snapshot.runningHandles.length > 0) {
		blocks.push(checkpointGuidanceText())
	}
	if (
		snapshot.exitedHandles.length === 0 &&
		snapshot.runningHandles.length === 0 &&
		snapshot.pendingHandles.length === 0
	) {
		blocks.push("No background processes or pending results remain.")
	}
	return blocks
}

/**
 * Build the `bash_control` ToolDefinition.
 *
 * @param getState Override the state accessor (tests inject a fake).
 *                 Defaults to the session-scoped `getSessionState()`.
 */
export function createBashControlToolDefinition(
	getState: () => BashSessionState | undefined = getSessionState,
): ToolDefinition<typeof bashControlSchema, BashControlDetails> {
	async function execute(
		toolCallId: string,
		params: BashControlInput,
		signal: AbortSignal | undefined,
		_onUpdate: Parameters<ToolDefinition["execute"]>[3] | undefined,
	): Promise<{
		content: { type: "text"; text: string }[]
		details: BashControlDetails
	}> {
		const { stopHandles, wait, rawWaitSeconds } = normalizeParams(params)

		// ── Operation-wide validation BEFORE any mutation (stops included). ──
		// Only `undefined` means "omitted"; every other shape — including
		// `null` — is a supplied value and must be a finite positive number
		// before any stop or wait can run, so invalid durations can never
		// fall through to the stop loop as though absent.
		const hasWaitSeconds = rawWaitSeconds !== undefined
		if (hasWaitSeconds && !wait) {
			return errorResult(
				"waitSeconds applies only to wait: true — a duration cannot affect an immediate inspection. Pass wait: true or omit waitSeconds.",
				"invalid-params",
			)
		}
		let effectiveWaitSeconds: number | undefined
		if (wait && hasWaitSeconds) {
			if (typeof rawWaitSeconds !== "number" || !Number.isFinite(rawWaitSeconds) || rawWaitSeconds <= 0) {
				return errorResult(
					`waitSeconds must be a finite positive number of seconds (got ${JSON.stringify(rawWaitSeconds)}).`,
					"invalid-params",
				)
			}
			// Requests above the cap are capped, not rejected.
			effectiveWaitSeconds = Math.min(rawWaitSeconds, MAX_WAIT_SECONDS)
		}
		if (wait) effectiveWaitSeconds ??= DEFAULT_WAIT_SECONDS

		const state = getState()
		if (!state) {
			return errorResult("No active bash session state. Start a background bash command first.", "no-registry")
		}
		const { coordinator } = state

		const blocks: string[] = []
		const exitedHandles: string[] = []

		// ── Apply explicit stops (continuation is the default for the rest). ──
		for (const handle of stopHandles) {
			const result = await collectTerminalResult(state, handle, undefined, toolCallId)
			blocks.push(result.text)
			if (result.resolved) exitedHandles.push(handle)
		}

		// ── wait: false → immediate inspection (stops applied above). ──
		if (!wait) {
			const snapshot = await collectCohortSnapshot(state, { toolCallId })
			blocks.push(...snapshotBlocks({ kind: "inspection" }, snapshot))
			exitedHandles.push(...snapshot.exitedHandles)
			// An inspection response reports fresh evidence: reset the
			// checkpoint streak of every running process it reports.
			coordinator.commitObservation(snapshot.runningHandles)
			return {
				content: [{ type: "text", text: blocks.join("\n\n") }],
				details: {
					exitedHandles,
					runningHandles: snapshot.runningHandles,
					pendingHandles: snapshot.pendingHandles,
					event: "inspection",
				},
			}
		}

		// ── Cohort wait. ──
		// Terminal outcomes awaiting delivery surface IMMEDIATELY: pending
		// results are checked BEFORE deciding the cohort is empty or starting
		// the wait timer. This covers BOTH cases where blocking would only
		// delay output that can be collected right now: a cohort with no live
		// processes at all, and a mixed cohort where a recoverable outcome
		// (available AND automatic-owned — e.g. released after an aborted run
		// dropped its notification) exists alongside a live survivor — the
		// wait never defers deliverable output to the 300s checkpoint.
		// Control-owned outcomes belong to another call. Automatic outcomes
		// either deliver here (available) or need a turn boundary (queued),
		// so neither may be postponed behind a live survivor's wait timer.
		const hasAutomaticOutcome = state.delivery.pendingHandles().some((handle) => {
			const pending = state.delivery.getPending(handle)
			return pending?.owner === "automatic"
		})
		if (coordinator.size === 0 || hasAutomaticOutcome) {
			const snapshot = await collectCohortSnapshot(state, { toolCallId })
			exitedHandles.push(...snapshot.exitedHandles)
			if (snapshot.exitedHandles.length > 0 || snapshot.pendingHandles.length > 0) {
				// Fresh terminal outcomes (or recovered post-abort outcomes)
				// surfaced by the sweep — queued-only outcomes report an
				// inspection; anything delivered makes it an exit response. Live
				// survivors keep running and are reported as running evidence.
				const mode: SnapshotMode =
					snapshot.exitedHandles.length === 0
						? { kind: "inspection" }
						: { kind: "exit", handle: snapshot.exitedHandles[0] ?? "" }
				blocks.push(...snapshotBlocks(mode, snapshot))
				coordinator.commitObservation(snapshot.runningHandles)
			} else if (exitedHandles.length > 0) {
				// Only stop outcomes — already delivered in this result above.
				blocks.push("No background processes or pending results remain.")
			} else {
				blocks.push(emptyWaitText())
			}
			return {
				content: [{ type: "text", text: blocks.join("\n\n") }],
				details: {
					exitedHandles,
					runningHandles: snapshot.runningHandles,
					pendingHandles: snapshot.pendingHandles,
					event: exitedHandles.length > 0 ? "exit" : snapshot.pendingHandles.length > 0 ? "inspection" : "empty",
				},
			}
		}

		const claim = coordinator.beginCohortWait(toolCallId)
		if (!claim.ok) {
			return errorResult(claim.error, "wait-conflict")
		}

		let event: Awaited<ReturnType<typeof coordinator.awaitCohortEvent>>
		const waitStartedAtMs = Date.now()
		try {
			event = await coordinator.awaitCohortEvent(toolCallId, signal, effectiveWaitSeconds, state.delivery)
		} finally {
			coordinator.endCohortWait(toolCallId)
		}
		// Measure the actual wait, never the requested duration (an exit
		// can resolve a 300s request after 17s). Clamped at zero for clock skew.
		const waitedSeconds = Math.max(0, Math.floor((Date.now() - waitStartedAtMs) / 1000))

		if (event.kind === "aborted") {
			// Abort cancels only this wait — the cohort keeps running. No
			// checkpoint count is committed and no cursor advances: the
			// cohort was not observed.
			const running = coordinator.handles().filter((handle) => state.registry.getEntry(handle)?.state === "running")
			const pendingHandles = state.delivery.pendingHandles().filter((handle) => !exitedHandles.includes(handle))
			blocks.push(
				`Wait cancelled after ${waitedSeconds}s. ${running.length} background process${running.length === 1 ? "" : "es"} still running.`,
			)
			if (pendingHandles.length > 0) {
				blocks.push(
					`${pendingHandles.length} exit result${pendingHandles.length === 1 ? " remains" : "s remain"} pending delivery.`,
				)
			}
			return {
				content: [{ type: "text", text: blocks.join("\n\n") }],
				details: {
					exitedHandles,
					pendingHandles,
					aborted: true,
					event: "aborted",
					effectiveWaitSeconds,
					waitedSeconds,
				},
			}
		}

		// Recheck the CURRENT cohort state while building the response: an
		// exit racing the timer must be delivered as terminal output, never
		// described as still running.
		const mode: SnapshotMode =
			event.kind === "checkpoint"
				? { kind: "checkpoint", requestedSeconds: effectiveWaitSeconds ?? 0, waitedSeconds }
				: event.kind === "exit"
					? { kind: "exit", handle: event.handle }
					: { kind: "inspection" }
		const snapshot = await collectCohortSnapshot(state, {
			settlementCheckpoint: event.kind === "checkpoint",
			toolCallId,
		})
		blocks.push(...snapshotBlocks(mode, snapshot))
		exitedHandles.push(...snapshot.exitedHandles)

		// The response event (and the streak bookkeeping) follows the event
		// that ended the WAIT, not whether requested stops or racing exits
		// also delivered terminal results in this response: a stop-plus-wait
		// that times out is still a checkpoint for the survivors (their
		// consecutive-checkpoint count increments), while a wait resolved by
		// an exit is a terminal-event response (their streaks reset). A wait
		// that settled because the cohort drained reports the exits its
		// outcomes represent, never a genuinely empty session.
		const responseEvent: BashControlEvent =
			event.kind === "checkpoint"
				? "checkpoint"
				: event.kind === "exit" || snapshot.exitedHandles.length > 0
					? "exit"
					: snapshot.pendingHandles.length > 0 || event.kind === "pending-delivery"
						? "inspection"
						: "empty"
		if (responseEvent === "checkpoint") coordinator.commitWaitTimeout(snapshot.runningHandles)
		else coordinator.commitObservation(snapshot.runningHandles)

		return {
			content: [{ type: "text", text: blocks.join("\n\n") }],
			details: {
				exitedHandles,
				runningHandles: snapshot.runningHandles,
				pendingHandles: snapshot.pendingHandles,
				event: responseEvent,
				effectiveWaitSeconds,
				waitedSeconds,
			},
		}
	}

	return {
		name: BASH_CONTROL_TOOL_NAME,
		label: "bash_control",
		description: BASH_CONTROL_TOOL_DESCRIPTION,
		parameters: bashControlSchema,
		execute: execute as ToolDefinition<typeof bashControlSchema, BashControlDetails>["execute"],
	}
}
