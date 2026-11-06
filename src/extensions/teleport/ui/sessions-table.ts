export type CombinedStatus = "active" | "idle" | "disconnected" | "completed" | "unreachable"

export interface SessionRow {
	workspaceId: string
	workspaceName: string
	sessionName: string
	/** Session cwd on the remote worker, when known. Used to prefill /sync paths. */
	cwd?: string
	status: CombinedStatus
	clientConnected: boolean
	lastActivityAt?: Date
}
