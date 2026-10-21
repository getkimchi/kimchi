import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { emitSteerFired, isSteerDisabled, type SteerKind, type SteerReason } from "../steer-events.js"
import { markHarnessSteer } from "../steer-marker.js"
import { watchSteerOutcome } from "../steer-outcome-watcher.js"
import { getOrCreateInnerMap } from "./nested-maps.js"
import type { TodoScope } from "./types.js"

/**
 * One-shot staleness steering.
 *
 * Staleness pressure used to be rendered inside the todo state block on every
 * request. That made the block content depend on volatile counters, which is
 * fine for a transient injection but breaks the persist-on-change model: the
 * persisted block must be a pure function of the todo store so it stays
 * byte-identical between real writes and can sit in the stable cache prefix.
 *
 * This module delivers the same pressure as bounded, one-shot steers: when a
 * per-scope counter crosses a threshold, a single hidden message is sent
 * (persisting in history at that point), and no more steers fire until the
 * epoch resets on the next relevant todo write.
 *
 * Counters and fired bands are per session AND per scope: a write to one
 * list (e.g. a ferment step) resets only that list's epoch, so a neglected
 * global list keeps aging — and keeps receiving reminders — while the other
 * list is being maintained.
 */

export const TODO_STALENESS_CUSTOM_TYPE = "todo-staleness"

/** Remind every N successful (non-todo) work calls since the scope's last
 *  write or successful confirmation — 10, 20, 30, … with no final
 *  ceiling. Each scope keeps its own schedule and resets independently. */
export const TODO_STALENESS_INTERVAL = 10

/** Human-readable scope label for staleness text, so the model knows which
 *  list to reconcile. */
export function stalenessScopeLabel(scope: TodoScope): string {
	if (scope.kind === "ferment-step") return `step ${scope.phaseId}/${scope.stepId}`
	if (scope.kind === "ferment") return `phase ${scope.phaseId}`
	return "global"
}

/** Interval reminder wording, scope-labelled so the model knows which list
 *  is stale. The schedule stays regular — only the wording strengthens: at
 *  the first two boundaries it asks for a refresh at the next natural
 *  breakpoint; from the third boundary (30 calls) onward it also asks the
 *  model to prune the list. */
export function stalenessIndicator(changes: number, scope: TodoScope): string | undefined {
	const label = stalenessScopeLabel(scope)
	if (changes < TODO_STALENESS_INTERVAL) return undefined
	if (changes < 3 * TODO_STALENESS_INTERVAL)
		return `${changes} changes since the ${label} todo list was last updated — refresh the list at the next natural breakpoint`
	return `⚠ ${changes} changes since the ${label} todo list was last updated — remove obsolete items or complete items whose work is done, then update the list at the next natural breakpoint`
}

/** Send a hidden persistent steer message (lands in session history at the
 *  current chronological position, so it joins the stable cache prefix).
 *  This is the single send path for staleness steers — the fire event
 *  and the kill switch live here so every staleness steer is measured
 *  and individually disableable. Returns whether the steer was actually
 *  delivered (false when the kill switch suppressed it). */
export function sendHiddenSteer(
	pi: ExtensionAPI,
	customType: string,
	text: string,
	details: Record<string, unknown>,
	opts: { steerKind?: SteerKind; steerReason?: SteerReason; interactive?: boolean; sessionId?: string } = {},
): boolean {
	if (opts.steerKind && isSteerDisabled(opts.steerKind)) return false
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
	return true
}

/** Local mirror of todos/index.ts's isTodoWriteToolName — importing it would
 *  pull this module back into the extension it lives in. Todo-tool names are
 *  stable (the upstream todo tool is built-in), so a small constant is the
 *  safe seam. */
const TODO_WRITE_TOOL_NAMES = new Set(["todo", "todo_write", "todowrite"])
function isTodoWriteTool(toolName: string): boolean {
	return TODO_WRITE_TOOL_NAMES.has(toolName.toLowerCase())
}

/** State for one session+scope: the highest interval boundary successfully
 *  delivered in the current write-epoch. A single number, not a set — the
 *  schedule is unbounded and storage must stay constant. */
interface ScopeIntervalBands {
	lastDelivered: number
}

/**
 * Interval reminder tracker: fires at every multiple of `interval` counts
 * since the scope's last reset, storing only the highest successfully
 * delivered boundary (so storage stays bounded no matter how long the
 * epoch runs). `reset` clears one scope's boundary (on a write or successful
 * confirmation for that scope); `clearSession` drops all boundaries for a
 * session (replay, shutdown). Only steers whose `send` callback reports
 * delivery advance the boundary — disabled or unsent reminders do not.
 *
 * If a count jumps across several boundaries in one evaluation, exactly one
 * reminder is sent, for the highest crossed boundary — never a burst of
 * stale ones.
 */
export function createIntervalSteerTracker(): {
	fireInterval(args: {
		sessionId: string
		/** Scope key (e.g. getTodoScopeKey) identifying the aging list. */
		scopeKey: string
		count: number
		interval: number
		send: (boundary: number) => boolean
	}): void
	reset(sessionId: string, scopeKey: string): void
	clearSession(sessionId: string): void
	/** Highest successfully delivered boundary in this write-epoch
	 *  (undefined when none delivered). */
	highestDelivered(sessionId: string, scopeKey: string): number | undefined
	clear(): void
} {
	const bandsBySession = new Map<string, Map<string, ScopeIntervalBands>>()

	function scopeBands(sessionId: string, scopeKey: string): ScopeIntervalBands {
		const byScope = getOrCreateInnerMap(bandsBySession, sessionId)
		const existing = byScope.get(scopeKey)
		if (existing) return existing
		const bands: ScopeIntervalBands = { lastDelivered: 0 }
		byScope.set(scopeKey, bands)
		return bands
	}

	return {
		fireInterval({ sessionId, scopeKey, count, interval, send }) {
			if (count < interval) return
			const bands = scopeBands(sessionId, scopeKey)
			const boundary = Math.floor(count / interval) * interval
			if (boundary <= bands.lastDelivered) return
			if (send(boundary)) bands.lastDelivered = boundary
		},
		reset(sessionId, scopeKey) {
			bandsBySession.get(sessionId)?.delete(scopeKey)
		},
		clearSession(sessionId) {
			bandsBySession.delete(sessionId)
		},
		highestDelivered(sessionId, scopeKey) {
			const last = bandsBySession.get(sessionId)?.get(scopeKey)?.lastDelivered
			return last === undefined || last <= 0 ? undefined : last
		},
		clear() {
			bandsBySession.clear()
		},
	}
}

/** State for one session+scope of the finite one-shot tracker: which
 *  thresholds have fired in the current epoch. */
interface ScopeBands {
	fired: Set<number>
}

/**
 * Tracks which thresholds have fired for each session and scope key within
 * the current write-epoch. `reset` clears one scope's fired set (on a write
 * to that scope) so the next epoch can fire again; `clearSession` drops all
 * bands for a session (replay, shutdown). Only steers whose `send` callback
 * reports delivery are recorded — disabled or unsent steers do not count as
 * delivered.
 *
 * Used by the ferment step-stall steer (one-shot per epoch); the recurring
 * staleness reminders use `createIntervalSteerTracker` above.
 */
export function createThresholdSteerTracker(): {
	fireCrossed(args: {
		sessionId: string
		/** Scope key (e.g. getTodoScopeKey) identifying the aging list. */
		scopeKey: string
		count: number
		thresholds: readonly number[]
		send: (threshold: number) => boolean
	}): void
	reset(sessionId: string, scopeKey: string): void
	clearSession(sessionId: string): void
	clear(): void
} {
	const bandsBySession = new Map<string, Map<string, ScopeBands>>()

	function scopeBands(sessionId: string, scopeKey: string): ScopeBands {
		const byScope = getOrCreateInnerMap(bandsBySession, sessionId)
		const existing = byScope.get(scopeKey)
		if (existing) return existing
		const bands: ScopeBands = { fired: new Set() }
		byScope.set(scopeKey, bands)
		return bands
	}

	return {
		fireCrossed({ sessionId, scopeKey, count, thresholds, send }) {
			const bands = scopeBands(sessionId, scopeKey)
			for (const threshold of thresholds) {
				if (count < threshold) continue
				if (bands.fired.has(threshold)) continue
				if (send(threshold)) bands.fired.add(threshold)
			}
		},
		reset(sessionId, scopeKey) {
			bandsBySession.get(sessionId)?.delete(scopeKey)
		},
		clearSession(sessionId) {
			bandsBySession.delete(sessionId)
		},
		clear() {
			bandsBySession.clear()
		},
	}
}
