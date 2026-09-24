/**
 * Translations for permission domain events (permissions extension) into OTLP
 * records. The permissions extension publishes facts on the pi.events bus;
 * this module converts them into telemetry, keeping telemetry decoupled from
 * permissions internals (same pattern as bash-tool-guard / loop-guard).
 */

import type {
	PermissionDecisionSourceDetail,
	PermissionToolDecisionPayload,
} from "../../permissions/permissions-events.js"
import { AUTO_MODEL_ID } from "../../router/constants.js"
import type { TelemetryContext } from "../session-context.js"

export const TOOL_DECISION_EVENT = "claude_code.tool_decision"

/**
 * Official Claude Code `claude_code.tool_decision` `source` vocabulary (see
 * https://code.claude.com/docs/en/monitoring-usage). It is a closed enum, so
 * kimchi's automated gates map onto it: `config` for mode/rule/builtin
 * decisions, `hook` for the auto-mode classifier. The mode itself is carried
 * by `permission_mode`.
 */
type DecisionSource = "config" | "hook" | "user_permanent" | "user_temporary" | "user_abort" | "user_reject"

const DECISION_SOURCE: Record<PermissionDecisionSourceDetail, DecisionSource> = {
	yolo_bypass: "config",
	plan_readonly: "config",
	plan_gate: "config",
	builtin_safe: "config",
	readonly: "config",
	ferment_internal: "config",
	compound_rule: "config",
	rule: "config",
	session_rule: "config",
	questionnaire_promotion: "config",
	no_ui: "config",
	mode_flap: "config",
	classifier: "hook",
	classifier_no_ui: "hook",
	allow_once: "user_temporary",
	allow_remember: "user_permanent",
	allow_remember_wildcard: "user_permanent",
	deny: "user_reject",
	deny_with_feedback: "user_reject",
	abort: "user_abort",
}

/**
 * Emit one `claude_code.tool_decision` log record per permission decision.
 *
 * Naming note: the official Claude Code attribute for the decision origin is
 * `source`, but TelemetryContext.emit spreads the session-origin `source`
 * ("cli"/"acp") AFTER event attributes, so it would overwrite ours. The
 * decision origin therefore goes out as `decision_source`; downstream
 * consumers (PostHog mapping) must use that key. `source` on the record
 * remains the session origin, consistent with every other kimchi event.
 *
 * Privacy: only enums and the provider-issued tool-call id are exported.
 */
export function handleToolDecision(tm: TelemetryContext, raw: unknown): void {
	const payload = raw as Partial<PermissionToolDecisionPayload> | undefined
	if (!payload?.toolCallId || !payload.toolName || !payload.sourceDetail || !payload.permissionMode) return
	if (payload.decision !== "accept" && payload.decision !== "reject") return
	// Drop out-of-contract values rather than exporting them.
	if (!Object.hasOwn(DECISION_SOURCE, payload.sourceDetail)) return
	const decisionSource = DECISION_SOURCE[payload.sourceDetail]

	tm.emit(
		TOOL_DECISION_EVENT,
		{
			tool_name: payload.toolName,
			tool_use_id: payload.toolCallId,
			decision: payload.decision,
			decision_source: decisionSource,
			source_detail: payload.sourceDetail,
			permission_mode: payload.permissionMode,
		},
		undefined, // no ExtensionContext — this fires from the pi.events bus
		{ model: acceptRateModel(tm) },
	)
}

/**
 * Model reported on the accept-rate record. `currentModel` tracks assistant
 * message models, which in Auto sessions name the router's concrete pick —
 * reporting that would make an Auto pick indistinguishable from a manual
 * selection of the same model. So report the user's selection (`auto`) when
 * the Auto router is active, the concrete model otherwise.
 */
function acceptRateModel(tm: TelemetryContext): string {
	return tm.selectedModelIsAuto ? AUTO_MODEL_ID : tm.currentModel
}
