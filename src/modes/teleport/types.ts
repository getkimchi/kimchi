export type RemoteSessionStatus = "active" | "idle" | "completed"

export interface RemoteSessionSummary {
	id: string
	name: string
	createdAt: Date
	lastActivityAt: Date
	status: RemoteSessionStatus
	hasConnectedClient: boolean
	host?: string
}

export class RemoteNetworkError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "RemoteNetworkError"
	}
}
