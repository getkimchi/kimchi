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

import type { ClassifierFailureCode, PermissionMode, PermissionModeState, RiskScore, RuleSource } from "./types.js"

export const PERMISSION_EVENTS = {
	MODE_CHANGED: "permissions:mode_changed",
	BEFORE_PROMPT: "permissions:before_prompt",
	AFTER_DECISION: "permissions:after_decision",
	TOOL_DECISION: "permissions:tool_decision",
	CONFIG_LOADED: "permissions:config_loaded",
	PLAN_APPROVED: "permissions:plan_approved",
	CLASSIFIER_UNAVAILABLE: "permissions:classifier_unavailable",
	CLASSIFIER_DEGRADED: "permissions:classifier_degraded",
} as const

export interface ClassifierUnavailablePayload {
	failureCode: Exclude<ClassifierFailureCode, "aborted">
	missingRefs: string[]
}

export interface ClassifierDegradedPayload {
	usedModelId: string
	missingRefs: string[]
}

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
	| "cloud_spawn_failed" // revert to plan mode when a cloud-agent spawn fails
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
// Tool decision (every gated permission decision, not just prompts)
// ---------------------------------------------------------------------------

/**
 * Why the gate decided (kept deliberately enum-bounded — never per-rule or
 * free-form strings). Telemetry maps each value onto the official Claude Code
 * `claude_code.tool_decision` `source` vocabulary.
 */
export type PermissionDecisionSourceDetail =
	| "yolo_bypass"
	| "plan_readonly"
	| "plan_gate"
	| "builtin_safe"
	| "readonly"
	| "ferment_internal"
	| "compound_rule"
	| "rule"
	| "session_rule"
	| "questionnaire_promotion"
	| "classifier"
	| "classifier_no_ui"
	| "no_ui"
	| "allow_once"
	| "allow_remember"
	| "allow_remember_wildcard"
	| "deny"
	| "deny_with_feedback"
	| "abort"
	| "mode_flap"

/**
 * Emitted for EVERY permission decision the tool_call gate makes — prompts and
 * automatic allows/denies alike. Usually once per tool call, with two
 * exceptions that share the parent `toolCallId`:
 *  - a prompt abort followed by re-evaluation under a new mode emits the abort
 *    and the re-evaluated outcome;
 *  - a compound bash command settled per subcommand emits one decision per
 *    evaluated segment.
 *
 * Not emitted for the IDE diff-viewer deferral (default mode + IDE connected):
 * the decision is made inside the IDE.
 *
 * Privacy: structured enums + ids only. No command text, file paths, rule
 * contents, or user feedback strings.
 */
export interface PermissionToolDecisionPayload {
	toolCallId: string
	toolName: string
	decision: "accept" | "reject"
	sourceDetail: PermissionDecisionSourceDetail
	/** Permission mode the decision was made under (for prompts: when the prompt opened). */
	permissionMode: PermissionMode
}

// ---------------------------------------------------------------------------
// Plan approved
// ---------------------------------------------------------------------------

/** Emitted when the user approves a plan-mode plan (the "Execute the plan locally"
 *  path). Subscribers use this to gate plan-progress reporting: pre-approval
 *  planning todos are the agent's scratchpad, not the plan itself. */
export interface PermissionPlanApprovedPayload {
	planPath?: string
}

// ---------------------------------------------------------------------------
// Config loaded
// ---------------------------------------------------------------------------

export interface PermissionConfigLoadedPayload {
	cwd: string
	ruleCount: number
	errors: string[]
}
