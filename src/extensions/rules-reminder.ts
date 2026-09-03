import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "./agent-worker-context.js"
import { getMultiModelEnabled } from "./multi-model.js"
import type { PromptMode } from "./prompt-construction/system-prompt.js"
import { resolvePromptVariant } from "./prompt-construction/variants/index.js"
import { getPromptMode } from "./prompt-mode-cache.js"
import { markHarnessSteer } from "./steer-marker.js"

export const RULES_REMINDER_TYPE = "rules-reminder"

/**
 * The prompt mode the next system-prompt build will use. Mirrors the choice in
 * prompt-enrichment: a worker never reaches here, so the multi-model setting
 * decides between the orchestrator and single-model sections.
 */
function derivePromptMode(ctx: ExtensionContext): PromptMode {
	return getMultiModelEnabled(ctx.sessionManager ?? null) ? "orchestrator" : "single"
}

export default function rulesReminderExtension(pi: ExtensionAPI): void {
	const cfg = resolvePromptVariant().rulesReminder
	if (!cfg) return
	if (isAgentWorker()) return

	// One timestamp per session: a process can serve several sessions, and each
	// of them has its own conversation whose rules age on its own clock.
	const lastInjectedAt = new Map<string, number>()

	pi.on("input", (event: InputEvent, ctx: ExtensionContext) => {
		if (event.source === "extension") return
		const sessionId = ctx.sessionManager?.getSessionId?.()
		if (!sessionId) return

		// The rules depend on the session's prompt mode, which is recorded when
		// the system prompt is built. The first prompt of a session arrives
		// before that build, so derive the mode from the same multi-model
		// setting the builder reads. From the second prompt on the recorded
		// value takes over, so a mid-session mode change still wins here.
		const mode = getPromptMode(sessionId) ?? derivePromptMode(ctx)
		const text = cfg.text(mode)
		if (!text) return

		const now = Date.now()
		const last = lastInjectedAt.get(sessionId)
		// The first prompt of a session always gets the rules: nothing in the
		// conversation carries them yet. After that the interval keeps them from
		// repeating on every turn.
		if (last !== undefined && now - last < cfg.intervalMs) return
		lastInjectedAt.set(sessionId, now)

		pi.sendMessage(
			{
				customType: RULES_REMINDER_TYPE,
				content: [{ type: "text", text: markHarnessSteer(text) }],
				display: false,
			},
			{ deliverAs: "nextTurn" },
		)

		// Only trace when prompt debugging is on: an unconditional write lands in
		// the middle of the terminal UI and corrupts what it is drawing.
		if (process.env.KIMCHI_DEBUG_PROMPTS === "1") {
			try {
				console.debug?.(`[rules-reminder] appended rules to session ${sessionId} (mode ${mode})`)
			} catch {
				// console.debug may be undefined in some environments — never throw.
			}
		}
	})

	pi.on("session_shutdown", (_event, ctx: ExtensionContext | undefined) => {
		const sessionId = ctx?.sessionManager?.getSessionId?.()
		if (sessionId) lastInjectedAt.delete(sessionId)
	})
}
