// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { Session } from "../../sandbox/worker/types.js"

/**
 * Picker-visibility predicate. Only PTY sessions that haven't finished are
 * usable as overlay tabs or session-picker rows; ACP/RPC sessions and
 * completed PTYs are filtered out.
 */
export function isVisibleSession(s: Session): boolean {
	return s.agentMode === "PTY" && !s.finishedAt
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
