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
 * `prompt-construction` records the effective prompt under the session ID at
 * `agent_start` (reading `ctx.getSystemPrompt()` — the finalized run options,
 * so appends from later-registered handlers such as the Claude Code hook
 * adapter's SessionStart delivery are included), and the export monkey-patches
 * read it back at export time.
 *
 * Keyed per session — the ACP server is a long-lived process hosting multiple
 * concurrent sessions (main, in-process subagents, different cwds), so a
 * single process-global slot would cross-contaminate exports.
 *
 * Eviction is ended-aware: only captures of sessions that have shut down
 * (`session_shutdown` with reason quit/new/resume/fork) are evictable, oldest
 * first. When every retained session is still live, the store grows past the
 * soft cap rather than evicting an active session's capture — an export of a
 * live session must never silently fall back to pi's base prompt (the bug
 * this module exists to fix). Growth is bounded in practice by the number of
 * concurrently live sessions; a new run re-records (and revives) a session's
 * entry, keeping the insertion order a recency signal.
 */

/** Soft cap on retained session prompts; ended sessions evict oldest-first. */
const MAX_RETAINED_SESSIONS = 64

interface StoredPrompt {
	prompt: string
	/** Whether the session has shut down in this process — evictable. */
	ended: boolean
}

// ---------------------------------------------------------------------------
// Module-level singleton store — one instance per process, shared across all
// importers. `let` (not `const`) so the internal reset helper can rebind.
// ---------------------------------------------------------------------------

let prompts: Map<string, StoredPrompt> = new Map()

/** Evict oldest ended entries while over the soft cap. Never evicts a live session. */
function evictIfNeeded(): void {
	while (prompts.size > MAX_RETAINED_SESSIONS) {
		let oldestEnded: string | undefined
		for (const [sessionId, stored] of prompts) {
			if (stored.ended) {
				oldestEnded = sessionId
				break
			}
		}
		if (oldestEnded === undefined) return // all live: grow rather than evict
		prompts.delete(oldestEnded)
	}
}

/**
 * Record the effective system prompt for a session — the finalized text the
 * run actually uses (including appended hook context), read from
 * `ctx.getSystemPrompt()` at `agent_start`.
 *
 * Re-recording for the same session overwrites and revives the entry (last
 * run wins — the prompt the model most recently ran with). Never throws: a
 * capture failure must not break the turn it observes.
 */
export function recordSessionSystemPrompt(sessionId: string, systemPrompt: string): void {
	try {
		if (!systemPrompt) return
		// Re-insert so an update refreshes the insertion-order position too.
		prompts.delete(sessionId)
		prompts.set(sessionId, { prompt: systemPrompt, ended: false })
		evictIfNeeded()
	} catch {
		// Never let the capture crash the turn.
	}
}

/**
 * Mark a session's capture as evictable — called when the session shuts down
 * in this process (`session_shutdown` with reason quit/new/resume/fork; a
 * resource "reload" keeps the session alive and must not mark it).
 */
export function markSessionSystemPromptEnded(sessionId: string): void {
	try {
		const stored = prompts.get(sessionId)
		if (stored) stored.ended = true
		// A shutdown can be what finally brings an over-cap store (all-live
		// growth) back under the soft cap — evict immediately rather than
		// waiting for the next capture elsewhere to trigger it.
		evictIfNeeded()
	} catch {
		// Never let the shutdown hook crash.
	}
}

/**
 * Returns the captured effective system prompt for a session, or `undefined`
 * when none was captured (or the entry was evicted).
 */
export function getSessionSystemPrompt(sessionId: string): string | undefined {
	return prompts.get(sessionId)?.prompt
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
		const captured = prompts.get(sessionId)?.prompt
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
