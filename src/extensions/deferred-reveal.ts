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
 *   `revealOnce()` directly from their own handler and pass the triggering
 *   tool call's id so its result carries the in-band load marker.
 *
 * Reveal mechanism (1.3.0):
 *
 * upstream pi removed `ToolResultMessage.addedToolNames` along with its in-band
 * wire delivery. Tool availability changes are now declared on system
 * messages (`SystemMessage.toolsAdded`/`toolsRemoved`), and the agent
 * session diffs the active tool set against the transcript itself, so an
 * extension only needs to flip the active set — no per-result stamping is
 * required or possible. The previous `message_end` stamping block was
 * already inert on every wire Kimchi serves and has been removed.
 */
export interface DeferredReveal {
	/**
	 * Reveal the tool group once; no-op after the first call or in workers.
	 *
	 * `stampToolCallId` is accepted for API compatibility but unused: 1.3.0
	 * has no per-result load marker (see the file header).
	 */
	revealOnce(stampToolCallId?: string): void
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

/**
 * Tool name → reveal function of the deferred group that hides it. Lets the
 * not-found backstop (hidden-tool-guidance) reveal ONLY tools hidden by a
 * deferral — never tools inactive for another reason (platform gate, plan
 * mode, print gate) — and release the group's visibility vote so later
 * profile/visibility recomputes do not hide the tool again.
 */
const deferredGroups = new Map<string, () => readonly string[] | undefined>()

/**
 * Reveal the deferred group that contains `toolName`, if that group is still
 * hidden. Returns the revealed tool names, or undefined when the tool belongs
 * to no deferred group or its group was already revealed (so something else
 * is hiding it).
 */
export function revealDeferredTool(toolName: string): readonly string[] | undefined {
	return deferredGroups.get(toolName)?.()
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

	for (const name of toolNames) {
		deferredGroups.set(name, () => {
			if (revealed || isAgentWorker()) return undefined
			revealOnce()
			return toolNames
		})
	}

	function revealOnce(_stampToolCallId?: string): void {
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
