/**
 * Shared outcome watcher for steer/nudge events.
 *
 * The three guard kinds with bespoke windows (`todo_early_nudge`,
 * `bash_tool_guard`, `loop_guard`) keep their own trackers; every other kind
 * previously fired `steer:fired` with no comply signal, so the dashboard
 * couldn't tell nudges apart. This module generalizes the pattern: a steer
 * site registers a watch when it fires, and the watcher classifies the
 * agent's subsequent behavior as "complied" / "repeated" — or "expired" when
 * the window closes or the session ends with no decision. Exactly one outcome
 * is emitted per registered watch, attributed back to the fire via steer_id.
 *
 * Privacy: the classifier returns an outcome code only. It never sees or
 * emits tool args, command text, or file paths — the classified event is
 * closed over, not forwarded.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { emitSteerOutcome, type SteerKind, type SteerOutcomePayload } from "./steer-events.js"

/** What the classifier saw, distilled to non-sensitive shape. */
export interface SteerObservedEvent {
	/** The pi event that fired. */
	type: "tool_execution_end" | "turn_end" | "input"
	/** Tool name for tool_execution_end (e.g. "bash", "write"). */
	toolName?: string
	/** Whether the turn's assistant message was text-only (no tool calls). */
	textOnly?: boolean
	/** Source for input events ("interactive" clears nothing here — the watcher
	 *  watches behavior, not attribution, and input doesn't expire a watch). */
}

export type SteerOutcomeClass = "complied" | "repeated"

interface Watch {
	kind: SteerKind
	steerId: string | undefined
	interactive: boolean
	/** Remaining tool calls before the window closes → "expired". */
	remainingToolCalls: number | undefined
	/** Remaining turns before the window closes → "expired". */
	remainingTurns: number | undefined
	/** Turns between fire and outcome (turns_to_outcome on the event). */
	turnsElapsed: number
	classify: (event: SteerObservedEvent) => SteerOutcomeClass | undefined
}

/** Watches keyed by session id for ACP multi-session hosts. The empty key is
 *  the fallback for ctx-less sites (correct on single-session hosts). */
const watchesBySession = new Map<string, Watch[]>()

function watches(sessionId: string): Watch[] {
	let list = watchesBySession.get(sessionId)
	if (!list) {
		list = []
		watchesBySession.set(sessionId, list)
	}
	return list
}

/**
 * Register an outcome watch for a steer fire. Pass the steer_id returned by
 * emitSteerFired/sendSteer so the outcome joins back to the fire. At least
 * one of `windowToolCalls` / `windowTurns` should be set; if both are unset
 * the watch lives until classify() returns an outcome or `expireSteerWatch`
 * runs on session end.
 */
export function watchSteerOutcome(opts: {
	kind: SteerKind
	steerId?: string
	sessionId?: string
	interactive: boolean
	windowToolCalls?: number
	windowTurns?: number
	classify: (event: SteerObservedEvent) => SteerOutcomeClass | undefined
}): void {
	watches(opts.sessionId ?? "").push({
		kind: opts.kind,
		steerId: opts.steerId,
		interactive: opts.interactive,
		remainingToolCalls: opts.windowToolCalls,
		remainingTurns: opts.windowTurns,
		turnsElapsed: 0,
		classify: opts.classify,
	})
}

let extensionPi: ExtensionAPI | undefined

function expire(pi: ExtensionAPI, sessionId: string): void {
	const list = watchesBySession.get(sessionId)
	if (!list?.length) return
	watchesBySession.delete(sessionId)
	for (const watch of list) emit(pi, sessionId, watch, "expired")
}

function emit(pi: ExtensionAPI, sessionId: string, watch: Watch, outcome: SteerOutcomePayload["outcome"]): void {
	emitSteerOutcome(pi, watch.kind, outcome, {
		interactive: watch.interactive,
		sessionId,
		steerId: watch.steerId,
		turnsToOutcome: watch.turnsElapsed,
	})
}

function processEvent(
	pi: ExtensionAPI,
	sessionId: string,
	event: SteerObservedEvent,
	countsAsTurn: boolean,
	countsAsToolCall: boolean,
): void {
	const list = watchesBySession.get(sessionId)
	if (!list?.length) return
	const remaining: Watch[] = []
	for (const watch of list) {
		if (countsAsTurn) watch.turnsElapsed += 1
		const outcome = watch.classify(event)
		if (outcome) {
			emit(pi, sessionId, watch, outcome)
			continue
		}
		if (countsAsToolCall && watch.remainingToolCalls !== undefined) {
			watch.remainingToolCalls -= 1
		}
		if (countsAsTurn && watch.remainingTurns !== undefined) {
			watch.remainingTurns -= 1
		}
		if (
			(watch.remainingToolCalls !== undefined && watch.remainingToolCalls <= 0) ||
			(watch.remainingTurns !== undefined && watch.remainingTurns <= 0)
		) {
			emit(pi, sessionId, watch, "expired")
			continue
		}
		remaining.push(watch)
	}
	if (remaining.length) watchesBySession.set(sessionId, remaining)
	else watchesBySession.delete(sessionId)
}

/**
 * Extension subscribing the watcher's pi events. Site-specific classify
 * logic stays in the emitting extension; this wires the shared window/expiry
 * mechanics once. Session end expires every open watch for that session.
 */
export function steerOutcomeWatcherExtension(pi: ExtensionAPI): void {
	extensionPi = pi
	pi.on("tool_execution_end", (event, ctx) => {
		processEvent(
			pi,
			ctx.sessionManager.getSessionId(),
			{ type: "tool_execution_end", toolName: event.toolName },
			false,
			true,
		)
	})
	pi.on("turn_end", (event, ctx) => {
		const msg = event.message
		const textOnly =
			msg.role === "assistant" &&
			Array.isArray(msg.content) &&
			!msg.content.some((c: { type?: string }) => c.type === "toolCall")
		processEvent(pi, ctx.sessionManager.getSessionId(), { type: "turn_end", textOnly }, true, false)
	})
	pi.on("session_shutdown", (_event, ctx) => {
		expire(pi, ctx.sessionManager.getSessionId())
	})
}

/** Test-only: clear all watches between tests. */
export function resetSteerOutcomeWatches(): void {
	watchesBySession.clear()
	extensionPi = undefined
}

/** Test-only: the shared pi handle, for asserting state in focused tests. */
export function _watcherPiForTest(): ExtensionAPI | undefined {
	return extensionPi
}
