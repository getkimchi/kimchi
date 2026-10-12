import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { emitSteerFired, isSteerDisabled, type SteerKind, type SteerReason } from "../steer-events.js"
import { markHarnessSteer } from "../steer-marker.js"
import { watchSteerOutcome } from "../steer-outcome-watcher.js"

/**
 * One-shot staleness steering.
 *
 * Staleness pressure used to be rendered inside the todo state block on every
 * request. That made the block content depend on volatile counters, which is
 * fine for a transient injection but breaks the persist-on-change model: the
 * persisted block must be a pure function of the todo store so it stays
 * byte-identical between real writes and can sit in the stable cache prefix.
 *
 * This module delivers the same pressure as bounded, persistent one-shot
 * steers: when a per-session counter crosses a threshold, a single hidden
 * message is sent (persisting in history at that point), and no more steers
 * fire until the epoch resets on the next relevant todo write.
 */

export const TODO_STALENESS_CUSTOM_TYPE = "todo-staleness"

/** Thresholds (post-increment count of non-todo tool calls) at which a
 *  staleness steer fires. Mirrors the old per-request indicator ranges. */
export const TODO_STALENESS_THRESHOLDS = [9, 17, 25] as const

/** Graduated staleness wording — the old `stalenessIndicator` text, moved out
 *  of the rendered block. */
export function stalenessIndicator(changes: number): string | undefined {
	if (changes <= 8) return undefined
	if (changes <= 16) return `${changes} changes since last update — refresh the list at the next natural breakpoint`
	if (changes <= 24) return `⚠ ${changes} changes since last update — update at the next natural breakpoint`
	return `⚠ ${changes} changes — list is significantly stale, update at the next natural breakpoint`
}

/** Send a hidden persistent steer message (lands in session history at the
 *  current chronological position, so it joins the stable cache prefix).
 *  This is the single send path for staleness steers — the fire event
 *  and the kill switch live here so every staleness steer is measured
 *  and individually disableable. */
export function sendHiddenSteer(
	pi: ExtensionAPI,
	customType: string,
	text: string,
	details: Record<string, unknown>,
	opts: { steerKind?: SteerKind; steerReason?: SteerReason; interactive?: boolean; sessionId?: string } = {},
): void {
	if (opts.steerKind && isSteerDisabled(opts.steerKind)) return
	pi.sendMessage(
		{
			customType,
			display: false,
			content: markHarnessSteer(text),
			details,
		},
		{ deliverAs: "steer" },
	)
	if (opts.steerKind) {
		const steerId = emitSteerFired(pi, opts.steerKind, opts.steerReason ?? "staleness", {
			interactive: opts.interactive,
			sessionId: opts.sessionId,
		})
		// Complied = a todo write within the next few non-todo tool calls;
		// repeated = the window closes on more non-todo work. Mirrors the
		// todo_early_nudge bespoke window (5). isTodoWriteToolName is imported
		// lazily to avoid a cycle back into todos/index.ts.
		watchSteerOutcome({
			kind: opts.steerKind,
			steerId,
			sessionId: opts.sessionId,
			interactive: opts.interactive === true,
			windowToolCalls: 5,
			classify: (event) =>
				event.type === "tool_execution_end" && event.toolName !== undefined && isTodoWriteTool(event.toolName)
					? "complied"
					: undefined,
		})
	}
}

/** Local mirror of todos/index.ts's isTodoWriteToolName — importing it would
 *  pull this module back into the extension it lives in. Todo-tool names are
 *  stable (the upstream todo tool is built-in), so a small constant is the
 *  safe seam. */
const TODO_WRITE_TOOL_NAMES = new Set(["todo", "todo_write", "todowrite"])
function isTodoWriteTool(toolName: string): boolean {
	return TODO_WRITE_TOOL_NAMES.has(toolName.toLowerCase())
}

/**
 * Tracks which thresholds have fired for each session within the current
 * write-epoch. `reset` clears the fired set so the next epoch can fire again.
 */
export function createThresholdSteerTracker(): {
	fireCrossed(args: {
		sessionId: string
		count: number
		thresholds: readonly number[]
		send: (threshold: number) => void
	}): void
	reset(sessionId: string): void
	clear(): void
} {
	const firedBySession = new Map<string, Set<number>>()

	return {
		fireCrossed({ sessionId, count, thresholds, send }) {
			let fired = firedBySession.get(sessionId)
			if (!fired) {
				fired = new Set()
				firedBySession.set(sessionId, fired)
			}
			for (const threshold of thresholds) {
				if (count < threshold) continue
				if (fired.has(threshold)) continue
				fired.add(threshold)
				send(threshold)
			}
		},
		reset(sessionId) {
			firedBySession.delete(sessionId)
		},
		clear() {
			firedBySession.clear()
		},
	}
}
