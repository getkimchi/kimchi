// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
// Cloud API client — workspace lifecycle (auth, list, delete, readiness probe).

export { authenticateWorkspace, createOrUpdateWorkspace, exchangeWorkspaceToken } from "./auth.js"
export { resolveEndpoint } from "./http.js"
export { verifyApiKey } from "./keys.js"
export { waitForWorkspaceReady } from "./readiness.js"
export type {
	AuthenticateOptions,
	ListWorkspacesOptions,
	VerifiedKey,
	WaitForWorkspaceReadyOptions,
	Workspace,
	WorkspaceCredentials,
	WorkspaceStatus,
} from "./types.js"
export { RemoteAuthError, RemoteNetworkError } from "./types.js"
export { normalizeWsUri } from "./uri.js"
export { deleteWorkspace, listWorkspaces } from "./workspaces.js"
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
