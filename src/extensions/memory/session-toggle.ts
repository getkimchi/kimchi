/**
 * Shared per-session memory runtime toggle.
 *
 * The session override is deliberately module-level state: it is the one
 * channel through which the ACP server (`set_memory_enabled` ext-method,
 * writing via `AgentSession.sessionManager`) and the in-session `/memory`
 * command (writing via the command context's `ctx.sessionManager`) can act
 * on the same session's memory runtime without the server reaching into the
 * extension closure. The key is the session-manager instance — the same
 * object both surfaces see for one session runtime (verified against the pi
 * SDK types: `ExtensionContext.sessionManager` and
 * `AgentSession.sessionManager` expose the same `SessionManager`). WeakMap
 * keys garbage-collect with dead sessions, so no unregister is needed.
 *
 * Semantics: `undefined` = default (memory active whenever the feature
 * resource is enabled); `false` = disabled for this session only (resets on
 * restart); `true` = explicitly re-enabled for this session. The effective
 * state is `getSessionMemoryOverride(key) ?? true`.
 */

// Key: the session's SessionManager instance — object identity is the
// session-runtime identity here.
const overrides = new WeakMap<object, boolean>()

/** The session's memory override, or undefined when it sits at the default. */
export function getSessionMemoryOverride(key: object): boolean | undefined {
	return overrides.get(key)
}

/**
 * Set (or clear, with undefined) the session's memory override. Flips are
 * picked up by the memory extension at the next agent start — flip
 * detection there resets the digest and delivery ledger.
 */
export function setSessionMemoryOverride(key: object, value: boolean | undefined): void {
	if (value === undefined) overrides.delete(key)
	else overrides.set(key, value)
}
