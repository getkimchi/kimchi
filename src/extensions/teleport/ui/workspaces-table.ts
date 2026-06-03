import type { WorkspaceStatus } from "../../../sandbox/cloud/types.js"

export interface WorkspaceRow {
	id: string
	name: string
	status: WorkspaceStatus
	createdAt?: Date
	lastActivityAt?: Date
	host?: string
	/** Number of sessions in the workspace, or "?" if the worker was unreachable. */
	sessionCount: number | "?"
}
