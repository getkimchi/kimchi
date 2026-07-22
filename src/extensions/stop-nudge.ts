/**
 * Single-model stop-nudge extension.
 *
 * In headless `--print` (benchmark) mode, when the model voluntarily stops
 * with `stopReason: "stop"` and no tool calls in the turn, the session ends
 * and the task is scored — even if the agent never produced output or verified
 * its work. This extension forces one extra turn by sending a
 * `{ triggerTurn: true }` nudge, giving the agent a chance to verify or
 * continue.
 *
 * Capped at 1 nudge per session (total, not consecutive). Unlike the plan-mode
 * stop-nudge (permissions/index.ts), the counter does NOT reset on tool-use
 * turns — a tool-use turn between stops usually means the agent verified its
 * work and then stopped legitimately, so resetting would turn every quick
 * completion into a wasteful re-verification loop.
 *
 * Excluded contexts (each has its own stop-nudge):
 * - Subagents (`isAgentWorker()`) — they have their own termination logic.
 * - Plan mode (`permissions/index.ts` plan_stop_nudge).
 * - Active ferment scoping (`ferment/nudge.ts`).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { contentHasToolCall } from "../shared/planning/planning-stop-nudge.js"
import { isAgentWorker } from "./agent-worker-context.js"
import { getPermissionMode } from "./permissions/mode-controller.js"

const MAX_STOP_NUDGES = 1

const SINGLE_MODEL_STOP_NUDGE =
	"You stopped without calling any tools this turn. " +
	"If you have completed the task, verify your solution by running any available tests or checks before finishing. " +
	"If you have not completed the task, continue working — do not stop until you have made concrete progress."

export default function stopNudgeExtension(pi: ExtensionAPI): void {
	let nudgeCount = 0

	pi.on("session_start", () => {
		nudgeCount = 0
	})

	pi.on("input", (event) => {
		// Only reset on real user input, not extension-injected messages
		// (including our own triggerTurn nudge). Matching the pattern in
		// exploration-guard.ts and loop-guard.ts.
		if (event.source === "extension") return
		nudgeCount = 0
	})

	pi.on("turn_end", (event, ctx) => {
		// Skip subagents — they have their own termination logic.
		if (isAgentWorker()) return

		const message = event.message
		if (message.role !== "assistant") return

		const stopReason = (message as { stopReason?: string }).stopReason
		// Only nudge on voluntary stops — not toolUse, error, length, or aborted.
		if (stopReason !== "stop") return

		const content = message.content as unknown[]

		// Skip turns that had tool calls — those are mid-session, not terminal.
		if (contentHasToolCall(content)) return

		// Skip plan mode — it has its own stop-nudge in permissions/index.ts.
		const sessionId = ctx.sessionManager.getSessionId()
		if (getPermissionMode(sessionId)?.mode === "plan") return

		// Skip active ferment scoping — it has its own stop-nudge in ferment/nudge.ts.
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const s: typeof import("./ferment/state.js") = require("./ferment/state.js")
			const fermentId = s.getActiveFermentId()
			if (fermentId && s.isScopingInteractive(fermentId)) return
		} catch {
			// ferment state module unavailable — not in ferment mode
		}

		// Total cap: 1 nudge per session. Do NOT reset on tool-use turns
		// (unlike the plan-mode nudge which resets on non-stop turns).
		// A tool-use turn between stops means the agent verified and stopped
		// again — that is a legitimate completion, not a stall.
		if (nudgeCount >= MAX_STOP_NUDGES) return
		nudgeCount++

		void pi.sendMessage(
			{
				customType: "single_model_stop_nudge",
				content: [{ type: "text", text: SINGLE_MODEL_STOP_NUDGE }],
				display: false,
			},
			{ triggerTurn: true },
		)
	})
}
