// Worker API client — per-workspace session lifecycle (HTTP, Bearer-JWT auth).

export { deriveBaseUrl, WorkerClient } from "./client.js"
export type { WorkerClientOptions } from "./client.js"
export { createSession, deleteSession, getSession, listSessions } from "./sessions.js"
export { getStatus } from "./status.js"
export type {
	AgentMode,
	CreateSessionRequest,
	SandboxStatus,
	Session,
	SessionDetails,
	SessionEvent,
	SessionEventType,
	SessionGitDetails,
	SessionStatus,
	SessionToolDetails,
	SessionToolsConfig,
} from "./types.js"
export { WorkerError } from "./types.js"
