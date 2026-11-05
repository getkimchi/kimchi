/**
 * Per-session system-prompt capture for session exports.
 *
 * Why this exists: pi 1.3.0 delivers an extension's `before_agent_start`
 * `systemPrompt` result as a per-run `forceSystemPrompt` projection that is
 * deliberately NEVER recorded in the transcript (the transcript keeps pi's
 * structured base-prompt sections for cache-friendly diffs, and
 * `_runSystemPromptOptions` is cleared when the run ends). Both export
 * surfaces therefore used to snapshot pi's base prompt instead of the
 * harness prompt: the HTML payload embeds `agent.state.systemPrompt` (a live
 * getter over the transcript's system message) and the JSONL header injection
 * used to be fed by the `AgentSession.systemPrompt` getter, which falls back
 * to `_baseSystemPromptOptions` once the session is idle.
 *
 * This store restores the pre-pi-1.3.0 export behavior capture-at-source:
 * `prompt-construction` records the final prompt text (the exact string the
 * model received, including appended `--append-system-prompt` content) under
 * the session ID at the single point where it exists, and the export
 * monkey-patches read it back at export time.
 *
 * Keyed per session — the ACP server is a long-lived process hosting multiple
 * concurrent sessions (main, in-process subagents, different cwds), so a
 * single process-global slot would cross-contaminate exports. Bounded:
 * ferment runs spawn many subagent sessions, so the map evicts the oldest
 * session's entry beyond the cap (~2 MB worst case at ~30 KB per prompt).
 */

/** Maximum number of session prompts retained; the oldest entries evict first. */
const MAX_RETAINED_SESSIONS = 64

// ---------------------------------------------------------------------------
// Module-level singleton store — one instance per process, shared across all
// importers. `let` (not `const`) so the internal reset helper can rebind.
// ---------------------------------------------------------------------------

let prompts: Map<string, string> = new Map()

/**
 * Record the effective system prompt for a session — the final text returned
 * from `before_agent_start`, after any appended prompt content.
 *
 * Re-recording for the same session overwrites (last turn wins — the prompt
 * the model most recently ran with). Never throws: a capture failure must not
 * break the turn it observes.
 */
export function recordSessionSystemPrompt(sessionId: string, systemPrompt: string): void {
	try {
		if (!systemPrompt) return
		// Re-insert so an update refreshes the insertion-order position too.
		prompts.delete(sessionId)
		prompts.set(sessionId, systemPrompt)
		while (prompts.size > MAX_RETAINED_SESSIONS) {
			const oldest = prompts.keys().next().value
			if (oldest === undefined) break
			prompts.delete(oldest)
		}
	} catch {
		// Never let the capture crash the turn.
	}
}

/**
 * Returns the captured effective system prompt for a session, or `undefined`
 * when none was captured (or the entry was evicted).
 */
export function getSessionSystemPrompt(sessionId: string): string | undefined {
	return prompts.get(sessionId)
}

/**
 * Resolve the system prompt an export should carry.
 *
 * The captured prompt (what the model actually ran with) wins; a whitespace-
 * only capture is treated as absent. Falls back to the caller-provided value
 * (the session getter — pi's base prompt) only when nothing was captured in
 * this process, preserving the pre-regression edge case of exporting a
 * freshly resumed session before its first turn.
 */
export function resolveExportSystemPrompt(sessionId: string | undefined, fallback?: string): string | undefined {
	if (sessionId) {
		const captured = prompts.get(sessionId)
		if (captured?.trim()) return captured
	}
	return fallback?.trim() || undefined
}

/**
 * @internal Test helper — clears the captured prompts so each test starts
 * from a pristine process-scoped store.
 */
export function _resetSessionSystemPromptStore(): void {
	prompts = new Map()
}
