/**
 * Permission domain event channels published via pi.events.
 *
 * The permissions extension emits these events; any extension (including
 * external `-e` loaded ones) can subscribe via `pi.events.on(channel, handler)`.
 * This keeps permission lifecycle observations decoupled from the permissions
 * extension internals.
 *
 * Privacy: payloads carry structured fields only (tool name, mode, decision
 * type). Raw command text, file paths, and user feedback strings are intentionally
 * NOT emitted — mirroring the bash-tool-guard and loop-guard stance.
 *
 * Interception: these channels are notification-only (fire-and-forget).
 * The EventBus.emit() returns void. For interception/blocking, extensions
 * should use the upstream `pi.on("tool_call", ...)` event which supports
 * returning `{ block: true, reason }`.
 */

import type { PermissionMode, PermissionModeState, RiskScore, RuleSource } from "./types.js"

export const PERMISSION_EVENTS = {
	MODE_CHANGED: "permissions:mode_changed",
	BEFORE_PROMPT: "permissions:before_prompt",
	AFTER_DECISION: "permissions:after_decision",
	CONFIG_LOADED: "permissions:config_loaded",
} as const

export type PermissionEventChannel = (typeof PERMISSION_EVENTS)[keyof typeof PERMISSION_EVENTS]

// ---------------------------------------------------------------------------
// Mode change
// ---------------------------------------------------------------------------

export type ModeChangeReason =
	| "user_shift_tab"
	| "ferment_elevation"
	| "ferment_restore"
	| "plan_approval"
	| "questionnaire_promotion"
	| "command"
	| "session_start"
	| "controller" // ACP/IDE SessionPermissionFlagController setMode callback

export interface PermissionModeChangedPayload {
	from: PermissionModeState
	to: PermissionModeState
	reason: ModeChangeReason
}

// ---------------------------------------------------------------------------
// Before / after prompt
// ---------------------------------------------------------------------------

export interface PermissionBeforePromptPayload {
	toolCallId: string
	toolName: string
	mode?: PermissionMode
	compound: boolean
	riskScore?: RiskScore
	classifierReason?: string
}

export type PermissionDecision =
	| "allow_once"
	| "allow_remember"
	| "allow_remember_wildcard"
	| "deny"
	| "deny_with_feedback"
	| "aborted"
	| "pick_per_subcommand"

export interface PermissionAfterDecisionPayload {
	toolCallId: string
	toolName: string
	decision: PermissionDecision
	ruleAdded?: {
		toolName: string
		behavior: "allow" | "deny"
		source: RuleSource
	}
}

// ---------------------------------------------------------------------------
// Config loaded
// ---------------------------------------------------------------------------

export interface PermissionConfigLoadedPayload {
	cwd: string
	ruleCount: number
	errors: string[]
}
