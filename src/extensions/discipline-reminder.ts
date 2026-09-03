import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "./agent-worker-context.js"
import { resolvePromptVariant } from "./prompt-construction/variants/index.js"
import { getSessionMode } from "./session-mode.js"
import { markHarnessSteer } from "./steer-marker.js"

export const DISCIPLINE_REMINDER_TYPE = "discipline-reminder"

export class DisciplineReminder {
	private completedRuns = 0

	/** Called on each run-end. Returns true on run 1 and every everyPrompts runs after that. */
	noteRunEnd(everyPrompts: number): boolean {
		this.completedRuns++
		return this.completedRuns === 1 || this.completedRuns % everyPrompts === 0
	}

	getCompletedRuns(): number {
		return this.completedRuns
	}
}

export default function disciplineReminderExtension(pi: ExtensionAPI): void {
	const cfg = resolvePromptVariant().disciplineReminder
	if (!cfg) return
	if (isAgentWorker()) return

	// One counter per session so a process serving several sessions keeps the
	// cadence of each one separate.
	const reminders = new Map<string, DisciplineReminder>()

	function reminderFor(sessionId: string): DisciplineReminder {
		const existing = reminders.get(sessionId)
		if (existing) return existing
		const created = new DisciplineReminder()
		reminders.set(sessionId, created)
		return created
	}

	pi.on("agent_end", (_event, ctx: ExtensionContext | undefined) => {
		const sessionId = ctx?.sessionManager?.getSessionId?.()
		if (!sessionId) return
		// The reminder wording depends on the session's prompt mode, which is
		// recorded when the prompt is built. Until then the mode is unknown, and
		// staying quiet beats sending the wrong mode's instructions.
		const mode = getSessionMode(sessionId)
		if (!mode) return
		if (!reminderFor(sessionId).noteRunEnd(cfg.everyPrompts)) return
		const text = typeof cfg.text === "function" ? cfg.text(mode) : cfg.text
		pi.sendMessage(
			{
				customType: DISCIPLINE_REMINDER_TYPE,
				content: [{ type: "text", text: markHarnessSteer(text) }],
				display: false,
			},
			{ deliverAs: "nextTurn" },
		)
	})

	pi.on("session_shutdown", (_event, ctx: ExtensionContext | undefined) => {
		const sessionId = ctx?.sessionManager?.getSessionId?.()
		if (sessionId) reminders.delete(sessionId)
	})
}
