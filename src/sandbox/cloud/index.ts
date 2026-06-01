// Cloud API client — workspace lifecycle (auth, list, delete, readiness probe).

export { authenticateWorkspace, createOrUpdateWorkspace, exchangeWorkspaceToken } from "./auth.js"
export { resolveEndpoint } from "./http.js"
export { verifyApiKey } from "./keys.js"
export { waitForWorkspaceReady } from "./readiness.js"
export { normalizeWsUri } from "./uri.js"
export { deleteWorkspace, listWorkspaces } from "./workspaces.js"

export type {
	AuthenticateOptions,
	ListWorkspacesOptions,
	WaitForWorkspaceReadyOptions,
	Workspace,
	WorkspaceCredentials,
	WorkspaceStatus,
} from "./types.js"
export { RemoteAuthError, RemoteNetworkError } from "./types.js"
