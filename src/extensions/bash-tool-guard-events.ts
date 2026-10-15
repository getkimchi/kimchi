/**
 * Bash-tool-guard domain event channels published via pi.events.
 *
 * The bash-tool-guard extension emits these events; the telemetry extension
 * subscribes to them. This keeps the guard isolated from telemetry and
 * ensures every steer/block is observed for analytics regardless of which
 * extension triggered it.
 */

import type { BashCategory } from "./bash-tool-guard.js"

export const BASH_TOOL_GUARD_EVENTS = {
	WARN: "bash_tool_guard:warn",
	BLOCK: "bash_tool_guard:block",
	ALLOWED_BY_USER_REQUEST: "bash_tool_guard:allowed_by_user_request",
} as const

export type BashToolGuardEventChannel = (typeof BASH_TOOL_GUARD_EVENTS)[keyof typeof BASH_TOOL_GUARD_EVENTS]

export interface BashToolGuardWarnPayload {
	/** The category that triggered the warn. Only `background` steers,
	 *  so warn events fire for backgrounding alone; the `BashCategory`
	 *  type still includes read/edit/write (classification contract). */
	category: BashCategory
	/** The tool name detected in the matched segment (e.g. "nohup",
	 *  "disown", "&"). Kept short and structured so telemetry can
	 *  aggregate without receiving raw command text. */
	tool: string
	/** How many times this category has been seen in the session so far. */
	count: number
	/** True in interactive sessions (UI present); false in print/protocol/
	 *  benchmark sessions. Added for steer telemetry. */
	interactive: boolean
}

export interface BashToolGuardBlockPayload {
	/** The category that was blocked. Only `background` steers, so block
	 *  events fire for backgrounding alone (and only when
	 *  `blockOnThreshold` is enabled); the `BashCategory` type still
	 *  includes read/edit/write (classification contract). */
	category: BashCategory
	/** The tool name detected in the matched segment (e.g. "nohup",
	 *  "disown", "&"). */
	tool: string
	count: number
	/** True in interactive sessions (UI present); false in print/protocol/
	 *  benchmark sessions. Added for steer telemetry. */
	interactive: boolean
}

export interface BashToolGuardAllowedByUserRequestPayload {
	category: BashCategory
	/** The tool name detected in the matched segment (e.g. "nohup",
	 *  "disown"). Only background matches reach the user-request path. */
	tool: string
}
