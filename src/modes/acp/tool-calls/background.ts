/**
 * Backgrounded bash tool calls on the ACP wire (LLM-4485; the ACP v2
 * Background Work RFD's entity model: work that outlives the turn stays on
 * the tool call that started it).
 *
 * A backgrounded bash tool result is a pre-exit HANDOFF, not the outcome:
 * the ACP `tool_call` reports `in_progress` and stays open on the session's
 * held map until the process exits, when the exit watcher flips it to its
 * final status with the exit outcome. Moved out of server.ts so the agent
 * class only pays for wiring; this module owns the whole lifecycle.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk"
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
	displayText: (sessionId: string, text: string) => string
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
 * The bash-background extension → ACP server exit hook (LLM-4485): one
 * `whenExited` watcher per held background handle. Exits are already batched
 * on the agent side (EXIT_BATCH_WINDOW_MS, 50 ms trailing), so no extra
 * debounce is needed on this path — each held call gets exactly one watcher
 * and one final update.
 */
export function watchBackgroundProcessExit(
	ctx: BackgroundToolCallContext,
	sessionId: string,
	held: Map<string, HeldBackgroundToolCall>,
	handle: string,
): void {
	const registry = getSessionState(sessionId)?.registry
	if (!registry) {
		// No live registry (extension absent or already torn down): drop the
		// hold — a client reload replays the call terminal from history, and a
		// dangling in_progress card would spin forever.
		held.delete(handle)
		return
	}
	void registry
		.whenExited(handle)
		.then(() => settleHeldBackgroundToolCall(ctx, sessionId, held, handle))
		.catch(() => {
			// Registry teardown (session shutdown) settles whenExited the same
			// way; the session record is being disposed alongside, so there is
			// nothing left to publish.
			held.delete(handle)
		})
}

/**
 * Flip a held background tool call to its FINAL status when its process
 * exits: "completed" on a clean zero exit, "failed" otherwise. The update
 * carries the exit outcome in the BackgroundBashToolDetails shape the live
 * bash path already publishes, so clients keying UI off rawOutput.details
 * see a consistent payload.
 */
function settleHeldBackgroundToolCall(
	ctx: BackgroundToolCallContext,
	sessionId: string,
	held: Map<string, HeldBackgroundToolCall>,
	handle: string,
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
	const reason = final?.reason ?? null
	const text = final?.content ?? ""
	ctx.send({
		sessionId,
		update: buildToolCallUpdate({
			toolCallId: call.acpToolCallId,
			piToolCallId: call.piToolCallId,
			status: exitCode === 0 && reason === null ? "completed" : "failed",
			content:
				text.length > 0 ? [{ type: "content", content: { type: "text", text: ctx.displayText(sessionId, text) } }] : [],
			rawOutput: {
				content: text.length > 0 ? [{ type: "text", text: ctx.displayText(sessionId, text) }] : [],
				details: {
					handle,
					exited: true,
					exitCode,
					reason,
					...(display ? { display } : {}),
				},
			},
		}),
	})
}
