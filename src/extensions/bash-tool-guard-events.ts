/**
 * Bash-tool-guard domain event channels published via pi.events.
 *
 * The bash-tool-guard extension emits these events; the telemetry extension
 * subscribes to them. This keeps the guard isolated from telemetry and
 * ensures every steer/block is observed for analytics regardless of which
 * extension triggered it.
 */

export const BASH_TOOL_GUARD_EVENTS = {
	WARN: "bash_tool_guard:warn",
	BLOCK: "bash_tool_guard:block",
	ALLOWED_BY_USER_REQUEST: "bash_tool_guard:allowed_by_user_request",
} as const

export type BashToolGuardEventChannel = (typeof BASH_TOOL_GUARD_EVENTS)[keyof typeof BASH_TOOL_GUARD_EVENTS]

export interface BashToolGuardWarnPayload {
	/** The read/edit/write category that triggered the warn. */
	category: "read" | "edit" | "write"
	/** The tool name detected in the matched segment (e.g. "cat", "sed").
	 *  Kept short and structured so telemetry can aggregate without
	 *  receiving raw command text. */
	tool: string
	/** How many times this category has been seen in the session so far. */
	count: number
}

export interface BashToolGuardBlockPayload {
	category: "read" | "edit" | "write"
	tool: string
	count: number
}

export interface BashToolGuardAllowedByUserRequestPayload {
	category: "read" | "edit" | "write"
	/** The tool name detected in the matched segment (e.g. "cat", "sed"). */
	tool: string
}
