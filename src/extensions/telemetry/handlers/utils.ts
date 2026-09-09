import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getAcpClientInfo } from "../../../modes/acp/state.js"
import { getProcessMultiModelEnabled } from "../../kimchi-process.js"
import { getPermissionMode } from "../../permissions/mode-controller.js"
import type { TelemetryAttributes } from "../session-context.js"

export function getAcpAttributes(): { acp_client_name: string; acp_client_version: string } | undefined {
	const acpClientInfo = getAcpClientInfo()
	if (acpClientInfo) {
		return {
			acp_client_name: acpClientInfo.name,
			acp_client_version: acpClientInfo.version,
		}
	}
	return undefined
}

/**
 * Returns session attributes common to this session,
 * derived from the active extension context.
 */
export function getPiSessionAttributes(ctx: ExtensionContext): TelemetryAttributes {
	const sessionId = ctx.sessionManager.getSessionId()
	const attrs: TelemetryAttributes = {
		pi_session_id: sessionId,
		pi_mode: ctx.mode,
	}
	const modelId = ctx.model?.id
	if (modelId !== undefined) {
		attrs.model = modelId
	}
	const permissionMode = getPermissionMode(sessionId)?.mode
	if (permissionMode !== undefined) {
		attrs.permission_mode = permissionMode
	}
	// Using the process flag to avoid querying the configuration file
	// in the case that the flag hasn't been persisted yet (slow).
	const multiModel = getProcessMultiModelEnabled(sessionId)
	if (multiModel !== undefined) {
		attrs.multi_model_enabled = multiModel
	}
	return attrs
}
