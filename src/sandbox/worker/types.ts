// Hand-mirrored from .claude/openapi.yaml. Field names match the schema verbatim.

/**
 * Well-known session tag keys. Tags ride the create-session request, are
 * persisted in the worker's config.json, and whitelisted keys are promoted
 * to worker log fields. `SESSION_TAG_PARENT_SESSION_ID` carries the local
 * (parent) kimchi session id so sandbox logs can be filtered by the session
 * a user exported (the id in the export filename / session header).
 * Mirrored as TagParentSessionID in the sandbox worker (Go).
 */
export const SESSION_TAG_PARENT_SESSION_ID = "parent_session_id"

export type AgentMode = "RPC" | "ACP" | "PTY"

export interface SessionGitDetails {
	repo?: string
	branch?: string
	targetDirectory?: string
	/** When true, the worker clones with --depth 1 --single-branch (no history). */
	noHistory?: boolean
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
 * Shape of the `request` part of the multipart `POST /api/session/{name}` body.
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
	freshClone?: boolean
	lastActivityAt?: string | null
}

/**
 * Worker session. The openapi schema is `allOf(CreateSessionRequest, SessionStatus)`; we
 * additionally lift `name` onto the object — the worker exposes it only as the map key in
 * `GET /session`, but downstream consumers (sorting, rendering the /remote-sessions table) want
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

export interface GitIdentity {
	host: string
	user: string
	secretRef: string
}

export interface CreateGitIdentityRequest {
	user: string
	secretRef: string
}

export interface UpdateGitIdentityRequest {
	user: string
	secretRef: string
}

export interface SetGitGlobalConfigRequest {
	user?: {
		name?: string
		email?: string
	}
}

export interface PutSecretRequest {
	name: string
	/** Base64-encoded value. */
	value: string
	injectIntoEnv?: boolean
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
