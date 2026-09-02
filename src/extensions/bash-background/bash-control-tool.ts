/**
 * `bash_control` companion tool — consolidated cohort control.
 *
 * Continuation is the default: the agent names only the processes it
 * wants to stop and whether it has nothing else to do:
 *
 *  - `stop_handles`: kill these handles (one or many) and include each
 *    final result in the consolidated response. Unknown handles are
 *    reported individually without discarding valid actions. All
 *    unlisted live handles KEEP RUNNING.
 *  - `wait: false`: apply stops and return immediately so the agent can
 *    do independent work. An empty no-op call (no stops, no wait) is
 *    rejected.
 *  - `wait: true`: apply stops, then block until the first process exit
 *    in the cohort, the next global cohort review, or abort — and return
 *    one consolidated snapshot of every process relevant to that event.
 *    At most one cohort wait may be active per session; a second
 *    concurrent wait is rejected with a clear error.
 *
 * Aborting a wait cancels only the wait — it never kills the cohort.
 * Batch results mark each process failure explicitly instead of throwing,
 * so one failed process cannot discard sibling statuses.
 *
 * Legacy `{ extend_seconds, checkin_interval }` timing fields (resumed
 * sessions, ACP replays) are accepted as deprecated, ignored compatibility
 * inputs for one release. Legacy `handle`/`action` payloads are NOT
 * translated — the harness owns cadence and deadlines now.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { type Static, Type } from "typebox"
import { elapsedSecondsSince } from "./process-registry.js"
import { type BashSessionState, getSessionState } from "./session-registry.js"
import { runningResultText, terminalResultText } from "./status-text.js"

const bashControlSchema = Type.Object({
	stop_handles: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Handles of background bash processes to stop now. All unlisted live handles continue running. Their final results are included in this call's response.",
		}),
	),
	wait: Type.Boolean({
		description:
			"true: after applying any stops, block until the first cohort process exit, the next scheduled cohort review, or abort, and return one consolidated snapshot. Use only when you have no independent work to do. false: apply stops and return immediately; processes continue by default and their exits/reviews arrive automatically.",
	}),
	/** @deprecated Ignored. Deadlines are harness-owned; retained one release so resumed sessions and ACP replays carrying legacy timing payloads still validate. */
	extend_seconds: Type.Optional(Type.Number()),
	/** @deprecated Ignored. The review cadence is harness-owned; retained for the same compatibility reason. */
	checkin_interval: Type.Optional(Type.Number()),
})

export type BashControlInput = Static<typeof bashControlSchema>

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
}

export const BASH_CONTROL_TOOL_NAME = "bash_control"

export const BASH_CONTROL_TOOL_DESCRIPTION = `Control background bash processes started by the \`bash\` tool.

Background processes continue by default: reviews of every running process and each process's final exit result are delivered to you automatically. You do NOT need to call this tool to keep a process alive or to collect its output.

- \`stop_handles\`: stop the named processes now and get their final results in one response. Every unlisted handle keeps running.
- \`wait: true\`: block until the first cohort exit or the next scheduled cohort review, then receive one consolidated snapshot. Use this ONLY when you have no independent work to do — never to poll a single process. Only one wait can be active at a time.
- \`wait: false\`: apply stops and return immediately.

A call with neither stop_handles nor wait: true is a no-op and is rejected.`

interface NormalizedParams {
	stopHandles: string[]
	wait: boolean
}

/** Drop empty handle values; the schema already validates the rest. */
function normalizeParams(params: BashControlInput): NormalizedParams {
	const stopHandles = params.stop_handles?.filter((h) => typeof h === "string" && h.length > 0) ?? []
	// wait is required by the schema; `=== true` keeps direct (unvalidated)
	// execute calls from resumed/ACP payloads deterministic too.
	return { stopHandles, wait: params.wait === true }
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

/** Format one terminal result block for `handle` and remove it everywhere. */
async function collectTerminalResult(
	state: BashSessionState,
	handle: string,
	prefix?: string,
): Promise<{ text: string; resolved: boolean }> {
	const { registry, coordinator } = state
	const entry = registry.getEntry(handle)
	if (!entry) {
		return {
			text: `${prefix ?? ""}Unknown handle '${handle}'. The process already exited and was removed (its result was delivered when it exited).`,
			resolved: false,
		}
	}
	const elapsed = elapsedSecondsSince(entry.spawnedAtMs)
	await registry.kill(handle).catch(() => {})
	const final = registry.finalSnapshot(handle)
	coordinator.handleRemoved(handle)
	await registry.remove(handle).catch(() => {})
	if (!final) {
		return { text: `${prefix ?? ""}Process ${handle} ended before its result could be captured.`, resolved: false }
	}
	const text = terminalResultText({
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
	return { text: prefix ? `${prefix}\n${text}` : text, resolved: true }
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
		const { stopHandles, wait } = normalizeParams(params)
		if (!wait && stopHandles.length === 0) {
			return errorResult(
				"Nothing to do: pass stop_handles to stop processes, or wait: true to block for the next cohort event. Processes continue by default without this call.",
				"no-op",
			)
		}

		const state = getState()
		if (!state) {
			return errorResult("No active bash session state. Start a background bash command first.", "no-registry")
		}
		const { registry, coordinator } = state

		const blocks: string[] = []
		const exitedHandles: string[] = []

		// ── Apply explicit stops (continuation is the default for the rest). ──
		for (const handle of stopHandles) {
			const result = await collectTerminalResult(state, handle)
			blocks.push(result.text)
			if (result.resolved) exitedHandles.push(handle)
		}

		if (!wait) {
			return {
				content: [{ type: "text", text: blocks.join("\n\n") }],
				details: { exitedHandles },
			}
		}

		// ── Cohort wait. ──
		if (coordinator.size === 0) {
			blocks.push("No background processes remain running; nothing to wait for.")
			return {
				content: [{ type: "text", text: blocks.join("\n\n") }],
				details: { exitedHandles },
			}
		}

		const claim = coordinator.beginCohortWait(toolCallId)
		if (!claim.ok) {
			return errorResult(claim.error, "wait-conflict")
		}

		let event: Awaited<ReturnType<typeof coordinator.awaitCohortEvent>>
		try {
			event = await coordinator.awaitCohortEvent(toolCallId, signal)
		} finally {
			coordinator.endCohortWait(toolCallId)
		}

		if (event.kind === "aborted") {
			// Abort cancels only this wait — the cohort keeps running.
			blocks.push(
				`Wait cancelled. ${coordinator.size} background process${coordinator.size === 1 ? "" : "es"} still running; ` +
					"their reviews and exit results will continue to arrive automatically.",
			)
			return {
				content: [{ type: "text", text: blocks.join("\n\n") }],
				details: { exitedHandles, aborted: true },
			}
		}

		// Sweep every cohort handle that reached a terminal state — the event's
		// own exit plus any siblings that settled in the same window (safety
		// limit, a parallel stop, …). Terminal results are delivered exactly
		// once: this consolidated result owns them.
		if (event.kind === "exit") {
			blocks.push(`Cohort event: process exited (${event.handle}).`)
		} else {
			blocks.push("Scheduled cohort review of all running background processes:")
		}
		const terminalHere: string[] = []
		for (const handle of [...cohortHandles(state)]) {
			const entry = registry.getEntry(handle)
			if (!entry || entry.state === "running") continue
			const result = await collectTerminalResult(state, handle)
			terminalHere.push(result.text)
			if (result.resolved) exitedHandles.push(handle)
		}
		blocks.push(...terminalHere)

		// Snapshot every still-running handle: facts + unseen output. The
		// delivered cursor advances only after the result text is built.
		const runningHandles: string[] = []
		const pendingMarks: Array<[string, number]> = []
		for (const handle of cohortHandles(state)) {
			const entry = registry.getEntry(handle)
			if (!entry || entry.state !== "running") continue
			runningHandles.push(handle)
			const incremental = registry.snapshotSince(handle)
			pendingMarks.push([handle, incremental.nextCursor])
			blocks.push(runningResultText(entry, incremental, state.cwd))
		}
		for (const [handle, cursor] of pendingMarks) registry.markDelivered(handle, cursor)
		if (runningHandles.length === 0) {
			blocks.push("No background processes remain running.")
		}

		return {
			content: [{ type: "text", text: blocks.join("\n\n") }],
			details: { exitedHandles, runningHandles },
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

/** Current cohort handles (the coordinator owns the live cohort set). */
function cohortHandles(state: BashSessionState): string[] {
	return state.coordinator.handles()
}
