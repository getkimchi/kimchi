import { isAcpSessionHost } from "../../modes/acp/state.js"

let prMonitoringPermitted = false

/** ACP initialize sets this before loading any session's extensions. */
export function setPRMonitoringPermitted(permitted: boolean): void {
	prMonitoringPermitted = permitted
}

export function isPRMonitoringPermitted(): boolean {
	return !isAcpSessionHost() || prMonitoringPermitted
}
