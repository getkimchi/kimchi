/**
 * Session-entry persistence for remote cloud runs.
 *
 * A remote run can outlive the kimchi process that started it (session
 * shutdown spares remote runs — they are owned by the worker). The run's
 * state is written into the session transcript as `remote_run:state` custom
 * entries so a resumed kimchi (kimchi --session <id>) can find the run and
 * reattach to it (see findResumableRemoteRuns + attachRemoteAgent).
 *
 * Entry lifecycle: a "running" entry is appended when the runner reports the
 * remote session ready (the RemoteSessionMeta + ACP session id only exist
 * then), and a terminal entry overwrites it (last-entry-wins) from the
 * completion path — so a non-terminal last entry means the process died with
 * the run still in flight.
 */

import type { RemoteSessionMeta } from "./manager/remote-agent-runner.js"

/** A remote run's persisted state. */
export interface RemoteRunState {
	/** The agent record id — stable across restarts so transcript/steer
	 *  references (agentId) keep resolving. */
	id: string
	/** What the agent was dispatched for (widget display). */
	description: string
	/** The remote session to attach to. */
	remoteSession: RemoteSessionMeta
	/** The ACP session id — session/load attaches by id, never by name;
	 *  without it the run cannot be resumed. */
	acpSessionId: string
	/** Origin label for completion handling ("plan", "ferment plan", ...). */
	remoteOrigin?: string
	/** Ferment id when the run executes a ferment plan. */
	fermentId?: string
	/** The agent's local transcript file. */
	outputFile?: string
	/** When the run started (ms epoch). */
	startedAt: number
	/** "running" while the run is in flight; a terminal entry overwrites. */
	status: "running" | "completed" | "error" | "stopped"
}

/** Shape of a `remote_run:state` custom entry in the session. */
export interface RemoteRunStateEntry {
	type: "custom"
	customType: "remote_run:state"
	data: RemoteRunState
	[key: string]: unknown
}

/** Appends a `remote_run:state` entry to the session transcript. */
export function persistRemoteRunState(
	pi: { appendEntry: (customType: string, data: unknown) => unknown },
	state: RemoteRunState,
): void {
	pi.appendEntry("remote_run:state", state)
}

/** Narrowing guard for `remote_run:state` entries — persisted data can come
 *  from an older session file, so validate the fields the resume path needs. */
function isRemoteRunStateEntry(entry: unknown): entry is RemoteRunStateEntry {
	if (typeof entry !== "object" || entry === null) return false
	const e = entry as { type?: unknown; customType?: unknown; data?: unknown }
	if (e.type !== "custom" || e.customType !== "remote_run:state") return false
	if (typeof e.data !== "object" || e.data === null) return false
	const d = e.data as Partial<RemoteRunState>
	return (
		typeof d.id === "string" &&
		typeof d.description === "string" &&
		typeof d.startedAt === "number" &&
		(d.status === "running" || d.status === "completed" || d.status === "error" || d.status === "stopped") &&
		typeof d.remoteSession === "object" &&
		d.remoteSession !== null &&
		typeof d.remoteSession.sessionName === "string" &&
		typeof d.acpSessionId === "string"
	)
}

/**
 * Scans the session branch for remote runs that were still in flight when
 * kimchi closed: the LAST `remote_run:state` entry per id wins, and only
 * non-terminal entries with the full reattach metadata are returned.
 */
export function findResumableRemoteRuns(sessionManager: { getBranch: () => unknown[] }): RemoteRunState[] {
	const lastById = new Map<string, RemoteRunState>()
	for (const entry of sessionManager.getBranch()) {
		if (!isRemoteRunStateEntry(entry)) continue
		lastById.set(entry.data.id, entry.data)
	}
	return [...lastById.values()].filter((state) => state.status === "running")
}
