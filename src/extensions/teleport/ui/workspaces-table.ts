// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
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
	/**
	 * Disambiguated display name. Falls back to `name` when the name is unique;
	 * adds an `-<id-prefix>` suffix on collisions, matching the SSH alias logic.
	 */
	displayName?: string
	/** Pod CPU request in millicores (1500 = 1.5 vCPU), when known. */
	cpuMillicores?: number
	/** Pod memory request in bytes, when known. */
	ramBytes?: number
	/** Persistent-volume claim size in bytes, when known. */
	pvcSizeBytes?: number
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
