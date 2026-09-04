import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "./agent-worker-context.js"
import { getActive, isInactiveOrPaused } from "./ferment/state.js"
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
	return getMultiModelEnabled(ctx.sessionManager) ? "orchestrator" : "single"
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
		// A subagent never gets these rules: it has no Agent tool, so the
		// delegation and review parts cannot be followed there. The worker guard
		// above already returns for in-process workers; this is the second net for
		// a session that reaches here with a subagent prompt mode recorded.
		if (mode === "subagent") return
		// A ferment in progress carries its own planner rules in the system
		// prompt, so the block leaves that part of the guidance to them. Paused
		// and finished ferments no longer supply those rules. A draft ferment is
		// deliberately treated as active too: the planner rules reach a draft only
		// in one-shot mode, but the user is mid-scoping either way, so the
		// delegation bullet stays out until the ferment ends.
		const fermentActive = !isInactiveOrPaused(getActive())
		const text = cfg.text(mode, fermentActive)
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
			console.debug(`[rules-reminder] appended rules to session ${sessionId} (mode ${mode})`)
		}
	})

	pi.on("session_shutdown", (_event, ctx: ExtensionContext | undefined) => {
		const sessionId = ctx?.sessionManager?.getSessionId?.()
		if (sessionId) lastInjectedAt.delete(sessionId)
	})
}
