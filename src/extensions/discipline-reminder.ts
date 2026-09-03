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

/** Counter key for run-end events that arrive without a session id. */
const UNSCOPED_SESSION_KEY = ""

export default function disciplineReminderExtension(pi: ExtensionAPI): void {
	const cfg = resolvePromptVariant().disciplineReminder
	if (!cfg) return
	if (isAgentWorker()) return

	// One counter per session so a process serving several sessions keeps the
	// cadence of each one separate.
	const reminders = new Map<string, DisciplineReminder>()

	function reminderFor(sessionId: string | undefined): DisciplineReminder {
		const key = sessionId ?? UNSCOPED_SESSION_KEY
		const existing = reminders.get(key)
		if (existing) return existing
		const created = new DisciplineReminder()
		reminders.set(key, created)
		return created
	}

	pi.on("agent_end", (_event, ctx: ExtensionContext | undefined) => {
		const sessionId = ctx?.sessionManager?.getSessionId?.()
		if (!reminderFor(sessionId).noteRunEnd(cfg.everyPrompts)) return
		const mode = getSessionMode(sessionId) ?? "single"
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
		reminders.delete(sessionId ?? UNSCOPED_SESSION_KEY)
	})
}
