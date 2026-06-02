export type CombinedStatus = "active" | "idle" | "disconnected" | "completed" | "unreachable"

export interface SessionRow {
	workspaceId: string
	workspaceName: string
	sessionName: string
	status: CombinedStatus
	clientConnected: boolean
	lastActivityAt?: Date
}

export function formatRelativeTime(d: Date, now: Date = new Date()): string {
	const diffMs = now.getTime() - d.getTime()
	if (diffMs < 0) return "just now"
	const sec = Math.floor(diffMs / 1000)
	if (sec < 60) return "just now"
	const min = Math.floor(sec / 60)
	if (min < 60) return `${min}m ago`
	const hr = Math.floor(min / 60)
	if (hr < 24) return `${hr}h ago`
	const days = Math.floor(hr / 24)
	if (days === 1) return "yesterday"
	return `${days}d ago`
}
