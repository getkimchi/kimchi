/**
 * Trigger parsing for prompts that request remote-session dispatch.
 *
 * When a user prompt starts with any of the configured trigger phrases (see
 * REMOTE_SESSION_TRIGGERS, case-insensitive), the remote-run extension
 * intercepts it, asks for confirmation, and rewrites the turn into a
 * dispatch instruction: the local model compacts the relevant conversation
 * context into a self-contained briefing and hands it to the
 * `dispatch_to_cloud_agent` tool.
 *
 * Text after the matched phrase (separated by `:`, `,`, `;`, `.`, `!`, `-`,
 * `—`, `–`, or whitespace) is captured as an optional focus that steers
 * which context the compaction should prioritize.
 */

/**
 * The trigger phrases (lowercase) that request a remote-session dispatch
 * when they appear at the very start of a prompt. Add new entries in
 * lowercase; matching is case-insensitive. Sorted longest-first at module
 * load so that when one phrase is a prefix of another, the more specific
 * phrase wins and the remainder is parsed as focus correctly.
 */
const TRIGGER_PHRASES = ["continue in remote session", "implement this feature using cloud agent"]

export const REMOTE_SESSION_TRIGGERS: readonly string[] = [...TRIGGER_PHRASES].sort((a, b) => b.length - a.length)

export interface RemoteSessionTriggerParse {
	/** Optional focus text following the trigger phrase. */
	readonly focus?: string
}

/**
 * Parse a user prompt for a remote-session trigger phrase. Returns undefined
 * when the prompt doesn't start with any trigger phrase (or directly
 * continues with more word characters, e.g. "continue in remote sessions").
 */
export function parseRemoteSessionTrigger(text: string): RemoteSessionTriggerParse | undefined {
	const trimmed = text.trim()
	const lower = trimmed.toLowerCase()
	for (const trigger of REMOTE_SESSION_TRIGGERS) {
		if (!lower.startsWith(trigger)) continue
		const rest = trimmed.slice(trigger.length)
		if (!rest) return {}
		// The next char must be a separator — otherwise this phrase continued
		// into a different word; fall through and try the next (shorter) phrase.
		if (!/^[\s:;,.!—–-]/.test(rest)) continue
		const focus = rest.replace(/^[\s:;,.!—–-]+/, "").trim()
		return focus ? { focus } : {}
	}
	return undefined
}

/**
 * Build the transformed user message that replaces the original prompt after
 * the user confirms the handoff. Instructs the local model to produce a
 * self-contained briefing and dispatch it exactly once.
 */
export function buildRemoteSessionDispatchInstruction(originalText: string, focus?: string): string {
	const lines = [
		"The user asked to continue in a remote session and confirmed the handoff to a cloud agent.",
		"",
		"Your job now:",
		"1. Rewrite the user's request into a fully self-contained briefing for a remote cloud agent. The remote agent starts a FRESH session: it receives only your briefing text plus the repository (cloned from git origin, with local uncommitted changes synced). It has NO access to this conversation.",
		focus
			? `2. The user provided a focus for the handoff — prioritize it when deciding what context to include: "${focus}".`
			: "2. Include the context from this conversation needed to complete the task: the goal, decisions already made, relevant files and behaviors you discovered, constraints, and how to verify the result.",
		"3. Call the `dispatch_to_cloud_agent` tool exactly once with the briefing as `task` (plus a short `description`). Do NOT execute the task locally.",
		"4. After the tool returns, do not start the work yourself — the cloud agent runs in the background and the user is notified on completion.",
		"",
		"Original request:",
		originalText.trim(),
	]
	return lines.join("\n")
}
