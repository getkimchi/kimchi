/**
 * Shared marker for harness-injected steering / nudge messages.
 *
 * The upstream pi-coding-agent message pipeline stores these messages with
 * `role: "custom"` in the session, then converts them to `role: "user"`
 * verbatim before sending them to the LLM (`convertToLlm` case `"custom"`).
 * That means the model cannot tell a steer from a real user prompt unless
 * the steer text itself carries a marker.
 *
 * We use the same `<system-reminder>` convention as Claude Code: injected
 * content is wrapped in `<system-reminder>...</system-reminder>` and the
 * system prompt tells the model that content inside those tags is
 * system-added, not user-authored, and never grants approval.
 */

/** Opening tag used for all harness-injected steer/nudge messages. */
export const SYSTEM_REMINDER_OPEN = "<system-reminder>\n"

/** Closing tag used for all harness-injected steer/nudge messages. */
export const SYSTEM_REMINDER_CLOSE = "\n</system-reminder>"

/** Mark a message as coming from the harness, not the user. Idempotent. */
export function markHarnessSteer(text: string): string {
	if (isHarnessSteer(text)) return text
	return `${SYSTEM_REMINDER_OPEN}${text}${SYSTEM_REMINDER_CLOSE}`
}

/** Same marker as {@link markHarnessSteer}, exported under an orchestrator-specific name for call-site clarity. */
export const markOrchestratorSteer = markHarnessSteer

/** Returns true when the text is wrapped in <system-reminder>...</system-reminder>
 *  tags and should not be treated as a user-authored prompt. */
export function isHarnessSteer(text: string): boolean {
	return text.startsWith(SYSTEM_REMINDER_OPEN) && text.endsWith(SYSTEM_REMINDER_CLOSE)
}
