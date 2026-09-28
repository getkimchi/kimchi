import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "./agent-worker-context.js"
import type { ToolVisibilityAPI } from "./prompt-construction/tool-visibility.js"

/**
 * Shared defer + one-way-reveal pattern for tool visibility.
 *
 * A deferred tool group starts hidden (disable vote, unless the session is an
 * agent worker — workers are profile-managed and keep full visibility) and is
 * revealed exactly once when its anchor fires. The caller invokes
 * `resetForSession()` from its own `session_start` handler — a reveal from a
 * previous session in the same process must not leak forward — keeping the
 * re-hide ordered with the rest of that handler's work (e.g. re-registering
 * tools before casting the disable votes).
 * - with `anchorToolName`, a `tool_result` handler reveals on the first
 *   successful (non-error) result from the anchor tool.
 * - callers with custom anchors (e.g. DAP's skill-read `tool_call`) call
 *   `revealOnce()` directly from their own handler.
 */
export interface DeferredReveal {
	/** Reveal the tool group once; no-op after the first call or in workers. */
	revealOnce(): void
	/** Re-hide the group for a fresh session (call from session_start). */
	resetForSession(): void
}

export interface DeferredRevealOptions {
	/** Anchor tool: reveal on its first successful (non-error) tool_result. */
	anchorToolName?: string
	/**
	 * When false, resetForSession() only resets the flag — the caller casts its
	 * own (possibly combined) disable vote. Defaults to true.
	 */
	hideOnReset?: boolean
}

export function createDeferredReveal(
	pi: ExtensionAPI,
	visibility: ToolVisibilityAPI,
	toolNames: readonly string[],
	opts: DeferredRevealOptions = {},
): DeferredReveal {
	let revealed = isAgentWorker()

	if (opts.anchorToolName) {
		pi.on("tool_result", (event) => {
			if (event.isError || event.toolName !== opts.anchorToolName || revealed) return
			revealOnce()
		})
	}

	function revealOnce(): void {
		if (revealed || isAgentWorker()) return
		revealed = true
		visibility.enable(toolNames)
	}

	return {
		revealOnce,
		resetForSession() {
			revealed = isAgentWorker()
			if (!revealed && opts.hideOnReset !== false) visibility.disable(toolNames)
		},
	}
}
