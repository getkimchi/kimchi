// Hand-mirrored from .claude/openapi.yaml. Field names match the schema verbatim.

export type AgentMode = "RPC" | "ACP" | "PTY"

export interface SessionGitDetails {
	repo?: string
	branch?: string
	targetDirectory?: string
}

export interface SessionToolDetails {
	version?: string
}

export interface SessionToolsConfig {
	autoDetect?: boolean
	additional?: Record<string, SessionToolDetails>
}

export interface SessionDetails {
	git?: SessionGitDetails
	tools?: SessionToolsConfig
}

/**
 * Shape of the `request` part of the multipart `POST /session/{name}` body.
 * The endpoint also accepts an optional `sessionFile` (session.jsonl) binary
 * part to seed/resume the new session.
 */
export interface CreateSessionRequest {
	agentMode: AgentMode
	yolo?: boolean
	cwd?: string
	details?: SessionDetails
	tags?: Record<string, string>
}

export interface SessionStatus {
	alive: boolean
	agentRunning: boolean
	clientConnected: boolean
	connectedThroughBridge: boolean
	startedAt?: string | null
	finishedAt?: string | null
	lastActivityAt?: string | null
}

/**
 * Worker session. The openapi schema is `allOf(CreateSessionRequest, SessionStatus)`; we
 * additionally lift `name` onto the object — the worker exposes it only as the map key in
 * `GET /session`, but downstream consumers (sorting, rendering the /sessions table) want
 * it inline. Client-side convenience, never sent over the wire.
 */
export interface Session extends CreateSessionRequest, SessionStatus {
	name: string
}

export type SessionEventType =
	| "session_created"
	| "client_connected"
	| "client_disconnected"
	| "agent_started"
	| "agent_ended"
	| "tool_executed"
	| "session_shutdown"
	| "process_exited"

export interface SessionEvent {
	at?: string | null
	type: SessionEventType
	details?: string | null
}

export interface SandboxStatus {
	sessionStatus: Record<string, SessionStatus>
	lastActivityAt: string
	anyAgentRunning: boolean
}

export class WorkerError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly body?: unknown,
	) {
		super(message)
		this.name = "WorkerError"
	}
}
