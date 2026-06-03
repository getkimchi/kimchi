import type { Session } from "../../sandbox/worker/types.js"

/**
 * Picker-visibility predicate. Only PTY sessions that haven't finished are
 * usable as overlay tabs or session-picker rows; ACP/RPC sessions and
 * completed PTYs are filtered out.
 */
export function isVisibleSession(s: Session): boolean {
	return s.agentMode === "PTY" && !s.finishedAt
}
