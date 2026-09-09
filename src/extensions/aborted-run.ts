import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

type MessageEntryLike = { type: "message"; message: { role?: string; stopReason?: string } } | { type?: string }

/**
 * True when the newest message in branch history is an assistant message
 * that was aborted (e.g. the user ran /compact mid-stream).
 *
 * Persisted state blocks (`todo-state`, `ferment-lifecycle`) must not be
 * flushed after an aborted run: the flush would make the block the newest
 * turn-start entry, and upstream compaction (`findCutPoint`) treats custom
 * messages as turn starts — under a small `keepRecentTokens` budget the cut
 * then lands on the block, so the interrupted turn is swallowed into the
 * summary instead of surviving in the kept tail. The pending block is
 * flushed at the settle of the next (unaborted) run instead.
 */
export function latestRunTailIsAborted(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager.getBranch() as readonly MessageEntryLike[]
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]
		if (entry?.type !== "message") continue
		const message = (entry as { message?: { role?: string; stopReason?: string } }).message
		if (!message?.role) continue
		return message.role === "assistant" && message.stopReason === "aborted"
	}
	return false
}
