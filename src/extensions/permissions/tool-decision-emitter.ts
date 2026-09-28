/**
 * Emits the `permissions:tool_decision` bus event: one per gated permission
 * decision, prompted or automatic.
 */

import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent"
import {
	PERMISSION_EVENTS,
	type PermissionDecisionSourceDetail,
	type PermissionToolDecisionPayload,
} from "./permissions-events.js"
import type { ApprovalOutcome, CompoundApprovalOutcome } from "./prompts.js"
import type { PermissionMode, Rule } from "./types.js"

/** Config vs remembered-session rule for rule-driven decisions. */
export function ruleSourceDetail(rule: Rule | undefined): PermissionDecisionSourceDetail {
	return rule?.source === "session" ? "session_rule" : "rule"
}

export function emitToolDecision(
	pi: ExtensionAPI,
	event: ToolCallEvent,
	permissionMode: PermissionMode,
	decision: "accept" | "reject",
	sourceDetail: PermissionDecisionSourceDetail,
): void {
	const payload: PermissionToolDecisionPayload = {
		toolCallId: event.toolCallId,
		toolName: event.toolName.toLowerCase(),
		decision,
		sourceDetail,
		permissionMode,
	}
	pi.events.emit(PERMISSION_EVENTS.TOOL_DECISION, payload)
}

/**
 * Map a prompt outcome to a tool_decision emission. "pick-per-subcommand" emits
 * nothing here — each segment's outcome is emitted individually in the loop.
 */
export function emitOutcomeDecision(
	pi: ExtensionAPI,
	event: ToolCallEvent,
	permissionMode: PermissionMode,
	kind: ApprovalOutcome["kind"] | CompoundApprovalOutcome["kind"],
): void {
	switch (kind) {
		case "allow-once":
		case "allow-all-once":
			emitToolDecision(pi, event, permissionMode, "accept", "allow_once")
			return
		case "allow-remember":
		case "allow-all-remember":
			emitToolDecision(pi, event, permissionMode, "accept", "allow_remember")
			return
		case "allow-remember-wildcard":
			emitToolDecision(pi, event, permissionMode, "accept", "allow_remember_wildcard")
			return
		case "deny":
			emitToolDecision(pi, event, permissionMode, "reject", "deny")
			return
		case "deny-with-feedback":
			emitToolDecision(pi, event, permissionMode, "reject", "deny_with_feedback")
			return
		case "aborted":
			emitToolDecision(pi, event, permissionMode, "reject", "abort")
			return
		case "pick-per-subcommand":
			return
	}
}
