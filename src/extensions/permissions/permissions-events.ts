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
 * Where a permission decision came from. Mirrors the official Claude Code
 * `claude_code.tool_decision` event vocabulary (see
 * https://code.claude.com/docs/en/monitoring-usage) so downstream consumers
 * and dashboards stay portable:
 *  - `config`: decided automatically (permission mode, allow/deny rules,
 *    builtin-safe tools, plan-mode gate).
 *  - `hook`: an automated gate decided (the auto-mode classifier).
 *  - `user_permanent` / `user_temporary`: the user accepted at a prompt,
 *    with/without a remembered (session-scoped) rule.
 *  - `user_reject` / `user_abort`: the user declined or aborted a prompt.
 */
export type PermissionDecisionSource =
	| "config"
	| "hook"
	| "user_permanent"
	| "user_temporary"
	| "user_abort"
	| "user_reject"

/**
 * Fine-grained origin of the decision (kept deliberately enum-bounded — never
 * per-rule or free-form strings). Lets consumers distinguish yolo/auto/default
 * handling without parsing `source`.
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
 * automatic allows/denies alike — exactly once per evaluated tool call
 * (a prompt abort followed by re-evaluation under a new mode produces two:
 * the abort and the re-evaluated outcome).
 *
 * This is the per-call acceptance signal that execution-side telemetry cannot
 * provide: an executed tool is indistinguishable between yolo, rule, and
 * explicit user approval, and prompts that were accepted leave no trace.
 *
 * Not emitted for the IDE diff-viewer deferral (default mode + IDE connected):
 * the decision is made inside the IDE — a known gap tracked as a follow-up.
 *
 * Privacy: structured enums only. No command text, file paths (`fileExtension`
 * is just the extension), rule contents, or user feedback strings.
 */
export interface PermissionToolDecisionPayload {
	toolCallId: string
	toolName: string
	decision: "accept" | "reject"
	source: PermissionDecisionSource
	sourceDetail: PermissionDecisionSourceDetail
	/** Permission mode active when the decision was made. */
	permissionMode: PermissionMode
	/** Edit tools only — bare extension (e.g. "ts") for language inference. */
	fileExtension?: string
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
