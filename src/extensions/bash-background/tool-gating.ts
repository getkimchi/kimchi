/**
 * Tool visibility gating for background bash.
 *
 * While a background bash process awaits a continue/stop decision from the
 * agent, `bash_control` must be the ONLY tool visible to the model for that
 * turn — so the agent is forced to respond with a control decision rather
 * than, say, starting a new `bash` command or calling `edit`.
 *
 * This module wraps `createToolVisibility(pi)` (the cooperative, vote-based
 * visibility layer used by `questionnaire`) with a small state machine:
 *
 *  - `suppressOthers()`: snapshot the currently active tools, then disable
 *    every one except `bash_control`. Idempotent — a second call while
 *    suppressed is a no-op (the snapshot is reused).
 *  - `restore()`: re-enable the tools that were hidden. Also idempotent.
 *
 * Because visibility is vote-based, our disable votes compose with other
 * extensions' votes: we only add/remove OUR votes, never clobber theirs.
 * `getDisabledToolNames` is consulted so we never re-surface a tool another
 * extension has hidden.
 *
 * The manager is per-session (created on `session_start`); the extension
 * wires `suppressOthers`/`restore` to bash result events and the
 * `bash_control` tool call.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { BASH_CONTROL_TOOL_NAME } from "./bash-control-tool.js"

export interface ToolGating {
	/**
	 * Hide every active tool except `bash_control`. Snapshots the active
	 * list on the first call so `restore()` can bring back exactly those
	 * that were hidden by this call. Idempotent.
	 */
	suppressOthers(): void

	/** Re-enable the tools hidden by the most recent `suppressOthers()`. Idempotent. */
	restore(): void

	/** True when suppression is currently in effect. */
	readonly isSuppressed: boolean
}

export function createToolGating(pi: ExtensionAPI): ToolGating {
	const visibility = createToolVisibilityLocal(pi)
	// Names we hid during the current suppression window. Kept so restore()
	// only re-enables what WE hid (vote-based — we can't remove other
	// extensions' votes, and we shouldn't try).
	let hiddenNames: string[] = []
	let suppressed = false

	function suppressOthers(): void {
		if (suppressed) return
		const active = pi.getActiveTools()
		// Disable everything except bash_control. Use a copy so we don't
		// mutate the runtime's array.
		const toHide = active.filter((name) => name !== BASH_CONTROL_TOOL_NAME)
		if (toHide.length === 0) {
			// Nothing to hide (e.g. bash_control is already the only tool).
			// Still mark suppressed so restore() is a clean no-op.
			suppressed = true
			hiddenNames = []
			return
		}
		visibility.disable(toHide)
		hiddenNames = toHide
		suppressed = true
	}

	function restore(): void {
		if (!suppressed) return
		if (hiddenNames.length > 0) {
			visibility.enable(hiddenNames)
		}
		hiddenNames = []
		suppressed = false
	}

	return {
		suppressOthers,
		restore,
		get isSuppressed() {
			return suppressed
		},
	}
}

// Isolate the import so tests can stub it. Kept here (not top-level) so the
// module degrades gracefully if the visibility layer is unavailable.
import { createToolVisibility } from "../prompt-construction/tool-visibility.js"

function createToolVisibilityLocal(pi: ExtensionAPI) {
	return createToolVisibility(pi)
}
