import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "./agent-worker-context.js"
import { resolvePromptVariant } from "./prompt-construction/variants/index.js"
import { getSessionMode } from "./session-mode.js"

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

	const reminder = new DisciplineReminder()

	pi.on("agent_end", (_event, ctx: ExtensionContext | undefined) => {
		if (!reminder.noteRunEnd(cfg.everyPrompts)) return
		const mode = getSessionMode(ctx?.sessionManager?.getSessionId?.()) ?? "single"
		const text = typeof cfg.text === "function" ? cfg.text(mode) : cfg.text
		pi.sendMessage(
			{
				customType: DISCIPLINE_REMINDER_TYPE,
				content: [{ type: "text", text }],
				display: false,
			},
			{ deliverAs: "nextTurn" },
		)
	})
}
