export type BridgeFailure = "spawn_error" | "payload_invalid" | "io_error" | "timeout"
export type DiagnosticReason = BridgeFailure | "bridge_missing" | "pending_capacity"
export type BridgeCommand = (
	cliPath: string,
	command: "hook" | "sync",
	cwd: string,
	payload?: Record<string, unknown>,
) => Promise<BridgeFailure | undefined>

export function createBridgeDiagnostics() {
	const reported = new Set<DiagnosticReason>()

	function log(reason: DiagnosticReason): void {
		if (reported.has(reason)) return
		reported.add(reason)
		console.error(`workspace activity diagnostic: ${reason}`)
	}

	return {
		note(reason: DiagnosticReason): void {
			log(reason)
		},
	}
}
