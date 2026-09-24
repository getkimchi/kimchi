/**
 * Translations for permission domain events (permissions extension) into OTLP
 * records. The permissions extension publishes facts on the pi.events bus;
 * this module converts them into telemetry, keeping telemetry decoupled from
 * permissions internals (same pattern as bash-tool-guard / loop-guard).
 */

import type { PermissionToolDecisionPayload } from "../../permissions/permissions-events.js"
import type { TelemetryContext } from "../session-context.js"

export const TOOL_DECISION_EVENT = "claude_code.tool_decision"

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
 * Privacy: the payload contract is enums + ids only (no commands, paths, or
 * feedback), asserted by tests in the permissions extension.
 */
export function handleToolDecision(tm: TelemetryContext, raw: unknown): void {
	const payload = raw as Partial<PermissionToolDecisionPayload> | undefined
	if (
		!payload ||
		!payload.toolName ||
		!payload.decision ||
		!payload.source ||
		!payload.sourceDetail ||
		!payload.permissionMode
	) {
		return
	}
	tm.emit(TOOL_DECISION_EVENT, {
		tool_name: payload.toolName,
		decision: payload.decision,
		decision_source: payload.source,
		source_detail: payload.sourceDetail,
		permission_mode: payload.permissionMode,
		...(payload.toolCallId ? { tool_use_id: payload.toolCallId } : {}),
		...(payload.fileExtension ? { file_extension: payload.fileExtension } : {}),
	})
}
