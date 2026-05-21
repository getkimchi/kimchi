// API client — authentication, session management, and readiness probing

export { authenticateRemoteSession } from "./authenticate.js"
export { getMe } from "./me.js"
export { listRemoteSessions } from "./sessions.js"
export { waitForSessionReady } from "./readiness.js"
export { verifyApiKey } from "./keys.js"
export { resolveEndpoint } from "./http.js"
export { normalizeWsUri } from "./uri.js"

export type {
	AuthenticateResponse,
	AuthenticateOptions,
	MeResponse,
	ListRemoteSessionsOptions,
	WaitForSessionReadyOptions,
} from "./types.js"
export { RemoteAuthError } from "./types.js"
