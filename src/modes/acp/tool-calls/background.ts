/**
 * Backgrounded bash tool calls on the ACP wire (the ACP v2 Background Work
 * RFD's entity model: work that outlives the turn stays on the tool call
 * that started it).
 *
 * A backgrounded bash tool result is a pre-exit HANDOFF, not the outcome:
 * the ACP `tool_call` reports `in_progress` and stays open on the session's
 * held map until the process exits, when the exit watcher flips it to its
 * final status with the exit outcome. Moved out of server.ts so the agent
 * class only pays for wiring; this module owns the whole lifecycle.
 */

import type { SessionNotification, ToolCallContent } from "@agentclientprotocol/sdk"
import type { BackgroundBashToolDetails } from "../../../extensions/bash-background/bash-background-tool.js"
import { getSessionState } from "../../../extensions/bash-background/session-registry.js"
import { buildToolCallUpdate } from "./utils.js"

/** One held background tool call: its live ACP id + the originating pi id. */
export type HeldBackgroundToolCall = {
	acpToolCallId: string
	piToolCallId: string
}

/** Wiring the module needs from the agent; kept explicit for testability. */
export type BackgroundToolCallContext = {
	send: (notification: SessionNotification) => void
	displayContent: <T>(sessionId: string, content: T[] | undefined) => T[] | undefined
	displayRecord: (sessionId: string, value: Record<string, unknown>) => Record<string, unknown>
	/** True while the calling session record is still the live one. */
	isCurrent: () => boolean
}

/**
 * Read the process-registry handle off a backgrounded bash result: the
 * pre-exit handoff carries `details.handoff === true` and a live `handle`
 * (see BackgroundBashToolDetails in bash-background/bash-background-tool.ts).
 * Detection is deliberately data-shaped (not toolName-gated) so any tool
 * adopting the same handoff contract composes.
 */
export function backgroundHandoffHandle(result: unknown): string | undefined {
	const details = (result as { details?: unknown } | null | undefined)?.details
	if (!details || typeof details !== "object") return undefined
	const d = details as { handoff?: unknown; handle?: unknown }
	if (d.handoff !== true || typeof d.handle !== "string" || d.handle.length === 0) return undefined
	return d.handle
}

/**
 * The LIVE handoff gate: the data-shaped detection above, plus a live
 * process registry. Without a registry (extension absent or session state
 * torn down) no exit watcher could ever settle a hold, so the result must
 * fall through to the normal terminal update — a held `in_progress` that
 * nothing settles would spin on the client forever.
 */
export function liveBackgroundHandoffHandle(sessionId: string, result: unknown): string | undefined {
	const handle = backgroundHandoffHandle(result)
	if (handle === undefined) return undefined
	return getSessionState(sessionId)?.registry ? handle : undefined
}

/**
 * Replay normalizer for a handoff result whose process is NOT held in this
 * harness process (a cross-process reload, or a fresh SessionRecord for the
 * same session id): replay presents the call with the recorded terminal
 * status, so strip the in-flight markers (`handoff`, `exited`) — a terminal
 * status next to `exited: false` contradicts itself for clients keying UI
 * off rawOutput.details. The recorded content and handle stay untouched:
 * they are factual history, not liveness claims.
 */
export function normalizeUnheldHandoffResult<T>(result: T): T {
	if (backgroundHandoffHandle(result) === undefined || !result || typeof result !== "object") return result
	const {
		handoff: _handoff,
		exited: _exited,
		...rest
	} = (result as unknown as { details: Record<string, unknown> }).details
	return { ...(result as Record<string, unknown>), details: rest } as T
}

/**
 * Hold a background tool call and arm its exit watcher — the complete
 * handoff registration. A second handoff for the SAME handle (e.g. a
 * foreground/re-background cycle re-tracking one process, invited by the
 * data-shaped detection) first settles the previous hold best-effort, so no
 * held call is stranded at `in_progress` forever; the new hold then owns
 * the process exit's final settle.
 */
export function holdAndWatchBackgroundToolCall(
	ctx: BackgroundToolCallContext,
	sessionId: string,
	held: Map<string, HeldBackgroundToolCall>,
	handle: string,
	call: HeldBackgroundToolCall,
): void {
	if (held.has(handle)) {
		settleHeldBackgroundToolCall(ctx, sessionId, held, handle, {
			exited: false,
			reason: "tracking superseded by a new handoff",
		})
	}
	held.set(handle, call)
	watchBackgroundProcessExit(ctx, sessionId, held, handle)
}

/**
 * The bash-background extension → ACP server exit hook: one `whenExited`
 * watcher per held background handle. Exits are already batched on the
 * agent side (EXIT_BATCH_WINDOW_MS, 50 ms trailing), so no extra debounce
 * is needed on this path — each held call gets exactly one watcher and one
 * final update.
 */
export function watchBackgroundProcessExit(
	ctx: BackgroundToolCallContext,
	sessionId: string,
	held: Map<string, HeldBackgroundToolCall>,
	handle: string,
): void {
	const registry = getSessionState(sessionId)?.registry
	if (!registry) {
		// Defense-in-depth (the live handoff gate already requires a
		// registry): without one no settle can ever arrive, so drop the hold —
		// a client reload replays the call terminal from history, and a
		// dangling in_progress card would spin forever.
		held.delete(handle)
		return
	}
	void registry
		.whenExited(handle)
		.then(() => settleHeldBackgroundToolCall(ctx, sessionId, held, handle))
		.catch(() => {
			// whenExited resolves for unknown handles and the registry's
			// execPromise converts exec failures to { exitCode: null }, so a
			// rejection here means teardown or contract drift. Settle
			// best-effort — a no-op once the record is disposed — so a live
			// client never keeps a spinner on a call nothing else will settle.
			settleHeldBackgroundToolCall(ctx, sessionId, held, handle)
		})
}

/**
 * Flip a held background tool call to its FINAL status when its process
 * exits: "completed" on a clean zero exit, "failed" otherwise. The update
 * carries the exit outcome in the BackgroundBashToolDetails shape the live
 * bash path already publishes (type-checked against it) and runs through
 * the same display substitution helpers as the handoff path, so both paths
 * stay in lockstep for clients keying UI off rawOutput.details.
 */
function settleHeldBackgroundToolCall(
	ctx: BackgroundToolCallContext,
	sessionId: string,
	held: Map<string, HeldBackgroundToolCall>,
	handle: string,
	override?: { exited?: boolean; reason?: string },
): void {
	// Only the LIVE record may publish: a disposed/replaced record's exit is
	// already moot to its (dead) client, and the identity check guards against
	// a same-id respawn owning the registry slot.
	if (!ctx.isCurrent()) return
	const call = held.get(handle)
	if (!call) return
	held.delete(handle)
	const registry = getSessionState(sessionId)?.registry
	const final = registry?.finalSnapshot(handle) ?? registry?.completedSnapshot(handle)?.final
	const display = registry?.displaySnapshot(handle) ?? registry?.completedSnapshot(handle)?.display
	const exitCode = final?.exitCode ?? null
	const reason = override?.reason ?? final?.reason ?? null
	const text = final?.content ?? ""
	const content: ToolCallContent[] = text.length > 0 ? [{ type: "content", content: { type: "text", text } }] : []
	const details: BackgroundBashToolDetails = {
		handle,
		exited: override?.exited ?? true,
		exitCode,
		reason,
		...(display ? { display } : {}),
	}
	ctx.send({
		sessionId,
		update: buildToolCallUpdate({
			toolCallId: call.acpToolCallId,
			piToolCallId: call.piToolCallId,
			status: exitCode === 0 && reason === null ? "completed" : "failed",
			content: ctx.displayContent(sessionId, content) ?? [],
			rawOutput: ctx.displayRecord(sessionId, {
				content: text.length > 0 ? [{ type: "text", text }] : [],
				details,
			}),
		}),
	})
}
