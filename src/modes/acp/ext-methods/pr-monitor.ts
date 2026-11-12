import { RequestError } from "@agentclientprotocol/sdk"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { getPRMonitor } from "../../../extensions/pr-monitor/index.js"
import type { PRMonitorState } from "../../../extensions/pr-monitor/types.js"

export async function handlePRMonitor(
	getSession: (id: string) => AgentSession | undefined,
	params: Record<string, unknown>,
	configure: boolean,
	notify: (sessionId: string, state: PRMonitorState) => void,
): Promise<Record<string, unknown>> {
	if (typeof params.sessionId !== "string" || !params.sessionId)
		throw RequestError.invalidParams(undefined, "sessionId is required")
	const sessionId = params.sessionId
	const session = getSession(sessionId)
	const monitor = session && getPRMonitor(session.sessionManager)
	if (!monitor) throw RequestError.invalidParams(undefined, "The PR monitor session is unavailable")
	if (configure && (typeof params.enabled !== "boolean" || typeof params.autoFix !== "boolean"))
		throw RequestError.invalidParams(undefined, "enabled and autoFix must be booleans")
	if (
		params.instructions !== undefined &&
		(typeof params.instructions !== "string" || params.instructions.length > 4000)
	)
		throw RequestError.invalidParams(undefined, "instructions must be a string of at most 4000 characters")
	monitor.setNotify((state) => notify(sessionId, state))
	try {
		const state = configure
			? await monitor.configure(params.enabled === true, params.autoFix === true, params.instructions)
			: await monitor.refresh()
		return { state }
	} catch (error) {
		throw RequestError.invalidParams(undefined, error instanceof Error ? error.message : String(error))
	}
}
