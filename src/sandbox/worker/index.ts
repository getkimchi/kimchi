// Worker API client — per-workspace session lifecycle (HTTP, Bearer-JWT auth).

export { deriveBaseUrl, WorkerClient } from "./client.js"
export type { WorkerClientOptions } from "./client.js"
export {
	createGitIdentity,
	deleteGitIdentity,
	getGitIdentity,
	listGitIdentities,
	setGitGlobalConfig,
	updateGitIdentity,
	upsertGitIdentity,
} from "./git-identity.js"
export { deleteSecret, putSecret } from "./secrets.js"
export type { PutSecretOptions } from "./secrets.js"
export { createSession, deleteSession, getSession, listSessions } from "./sessions.js"
export { getStatus } from "./status.js"
export type {
	AgentMode,
	CreateGitIdentityRequest,
	CreateSessionRequest,
	GitIdentity,
	PutSecretRequest,
	SandboxStatus,
	Session,
	SessionDetails,
	SessionEvent,
	SessionEventType,
	SessionGitDetails,
	SessionStatus,
	SessionToolDetails,
	SessionToolsConfig,
	SetGitGlobalConfigRequest,
	UpdateGitIdentityRequest,
} from "./types.js"
export { WorkerError } from "./types.js"
