/**
 * `bash_control` extension.
 *
 * Registers the `bash_control` companion tool (from `./bash-control-tool.js`)
 * and wires tool-visibility gating so that, while a background bash process
 * awaits a continue/stop decision, `bash_control` is the only tool visible
 * to the agent for that turn.
 *
 * Architecture (blocking model):
 *
 * The `bash` tool's `execute()` blocks until the first checkin (timer vs
 * process exit race via `awaitCheckin`), then resolves with a handle. The
 * agent sees only `bash_control` (gating suppresses everything else) and
 * must call it. `bash_control continue` also blocks until the next checkin,
 * naturally pacing the loop — no `terminate`, no timer nudge, no reliance
 * on the event loop staying alive. Works in both interactive and one-shot
 * (`-p`) modes.
 *
 * Gating lifecycle:
 *  - When a `bash` result carries `checkin: true` (process still running),
 *    suppress all other tools.
 *  - When `bash_control` returns with `checkin: true` (process still running
 *    after continue), stay suppressed.
 *  - When `bash_control` returns with `exited: true` (stop or process exit),
 *    restore all tools.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createBashControlToolDefinition } from "./bash-control-tool.js"
import { createToolGating, type ToolGating } from "./tool-gating.js"

export default function bashControlExtension(pi: ExtensionAPI): void {
	let gating: ToolGating | undefined

	pi.on("session_start", () => {
		gating = createToolGating(pi)
		pi.registerTool(createBashControlToolDefinition())
	})

	pi.on("tool_result", (event) => {
		if (!gating) return
		const name = event.toolName

		if (name === "bash") {
			const details = event.details as { handle?: string; checkin?: boolean; exited?: boolean } | undefined
			if (details?.handle && details.checkin && !details.exited) {
				// Background checkin — suppress all tools except bash_control.
				gating.suppressOthers()
			} else {
				// Short-task path (no handle) or background exit — restore.
				if (gating.isSuppressed) gating.restore()
			}
			return
		}

		if (name === "bash_control") {
			const ctrlDetails = event.details as { handle?: string; checkin?: boolean; exited?: boolean } | undefined
			if (ctrlDetails?.handle && ctrlDetails.checkin && !ctrlDetails.exited) {
				// Continue with process still running — stay suppressed.
				if (!gating.isSuppressed) gating.suppressOthers()
			} else {
				// Process exited or was stopped — restore all tools.
				if (gating.isSuppressed) gating.restore()
			}
		}
	})

	// Safety net: restore on user input so a stuck suppression can't
	// lock the agent out of its tools if a turn is interrupted.
	pi.on("input", () => {
		if (gating?.isSuppressed) gating.restore()
	})

	pi.on("session_shutdown", () => {
		if (gating?.isSuppressed) gating.restore()
		gating = undefined
	})
}

// Re-export for the index barrel so cli.ts can import both extensions together.
export { bashBackgroundExtension } from "./index.js"
