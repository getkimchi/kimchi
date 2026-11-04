// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
// Worker API client — per-workspace session lifecycle (HTTP, Bearer-JWT auth).

export type { WorkerClientOptions } from "./client.js"
export { deriveBaseUrl, WorkerClient } from "./client.js"
export {
	createGitIdentity,
	deleteGitIdentity,
	getGitIdentity,
	listGitIdentities,
	setGitGlobalConfig,
	updateGitIdentity,
	upsertGitIdentity,
} from "./git-identity.js"
export type { PutSecretOptions } from "./secrets.js"
export { deleteSecret, putSecret } from "./secrets.js"
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
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
