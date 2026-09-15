import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import { verifyApiKey } from "./keys.js"
import type { AuthenticateOptions, WorkspaceCredentials } from "./types.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"
import { normalizeWsUri } from "./uri.js"

/**
 * Shared auth skeleton: verify API key → resolve workspace → exchange token
 * → normalized credentials, with uniform error wrapping. `resolveWorkspace`
 * is the only step that differs per entry point (upsert+resume vs read-only
 * GET); verify/exchange/normalize are identical for all of them.
 */
async function authenticateVia(
	workspaceId: string,
	apiKey: string,
	options: AuthenticateOptions | undefined,
	resolveWorkspace: (orgId: string, fetchImpl: typeof globalThis.fetch) => Promise<{ uri: string }>,
): Promise<WorkspaceCredentials> {
	const fetchImpl = options?.fetch ?? globalThis.fetch

	try {
		const orgId = await verifyApiKey(apiKey, { ...options, fetch: fetchImpl })
		const workspace = await resolveWorkspace(orgId, fetchImpl)
		const { token, expireTime } = await exchangeWorkspaceToken(apiKey, workspaceId, {
			...options,
			fetch: fetchImpl,
		})

		const { wsUrl, host } = normalizeWsUri(workspace.uri)

		return {
			connectToken: token,
			expiresAt: expireTime,
			wsUrl,
			host,
		}
	} catch (err) {
		if (err instanceof RemoteAuthError || err instanceof RemoteNetworkError) {
			throw err
		}
		throw new RemoteNetworkError(err instanceof Error ? err.message : String(err))
	}
}

/**
 * Four-step authentication flow:
 * 1. Verify API key → organizationId.
 * 2. Create or update workspace → get WebSocket URI.
 * 3. Resume workspace (wakes a hibernated sandbox pod) → no-op when running.
 * 4. Exchange for workspace token → get JWT for WebSocket auth.
 */
export async function authenticateWorkspace(
	workspaceId: string,
	apiKey: string,
	description: string,
	options?: AuthenticateOptions,
): Promise<WorkspaceCredentials> {
	return authenticateVia(workspaceId, apiKey, options, async (orgId, fetchImpl) => {
		const workspace = await createOrUpdateWorkspace(orgId, workspaceId, apiKey, description, {
			...options,
			fetch: fetchImpl,
		})
		// Wake a hibernated workspace if needed — failures propagate honestly
		// (see resumeWorkspace).
		await resumeWorkspace(orgId, workspaceId, apiKey, { ...options, fetch: fetchImpl })
		return workspace
	})
}

/**
 * Resumes a suspended (hibernated) workspace: POST
 * /ai-optimizer/v1beta/organizations/{org}/workspaces/{id}:resume.
 *
 * Hibernation is a replica-count state (the operator scales the sandbox pod
 * to 0 on inactivity); the workspace upsert only refreshes DB metadata and
 * never touches replicas, so it CANNOT wake a hibernated workspace — only
 * this RPC can (it scales the pod back to 1).
 *
 * Success and "workspace is not suspended" (FailedPrecondition → HTTP 400
 * wrapping ErrWorkspaceNotSuspended) both mean the workspace is running and
 * resolve normally. Every other failure propagates as the typed cloud error.
 */
async function resumeWorkspace(
	orgId: string,
	workspaceId: string,
	apiKey: string,
	options?: AuthenticateOptions,
): Promise<void> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}:resume`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		},
		fetchImpl,
	)

	if (resp.ok) return

	// Clone BEFORE consuming the body: checkResponse re-reads resp.text(),
	// and undici answers a second read with "Body is unusable" — checkResponse
	// would then build the error from an empty body, losing the server's
	// message and the RemoteQuotaError classification for 429s.
	const rest = resp.clone()

	// "Not suspended" = workspace already running — desired end state. Other
	// FailedPrecondition rejections carry different messages (e.g. sandbox
	// creation disabled) and must surface.
	const body = await resp.text().catch(() => "")
	if (resp.status >= 400 && resp.status < 500 && body.includes("not suspended")) {
		return
	}

	await checkResponse(rest, url)
}

/**
 * Read-only probe authentication: verify API key → GET workspace →
 * exchange token. Unlike authenticateWorkspace it has NO side effects —
 * no upsert PUT and no resume POST — so it never mutates workspace
 * metadata and never wakes a hibernated pod. Used by ownership probes
 * (isRemoteSessionConnected) that must not perturb the workspace and
 * must not fail on resume quota errors.
 */
export async function authenticateWorkspaceProbe(
	workspaceId: string,
	apiKey: string,
	options?: AuthenticateOptions,
): Promise<WorkspaceCredentials> {
	return authenticateVia(workspaceId, apiKey, options, (orgId, fetchImpl) =>
		getWorkspace(orgId, workspaceId, apiKey, { ...options, fetch: fetchImpl }),
	)
}

export async function getWorkspace(
	orgId: string,
	workspaceId: string,
	apiKey: string,
	options?: AuthenticateOptions,
): Promise<{ uri: string }> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		},
		fetchImpl,
	)

	await checkResponse(resp, url)

	const data = await resp.json().catch(() => {
		throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
	})

	const uri = data.uri
	if (typeof uri !== "string") {
		throw new RemoteNetworkError(`Missing uri in workspace response from ${endpoint}`)
	}

	return { uri }
}

export async function createOrUpdateWorkspace(
	orgId: string,
	workspaceId: string,
	apiKey: string,
	description: string,
	options?: AuthenticateOptions,
): Promise<{ uri: string; description: string }> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "PUT",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				description,
				options: {
					agentApiKey: apiKey,
					...(options?.gitToken ? { gitToken: options.gitToken } : {}),
				},
				// Create-time-only resource requests — sent verbatim; omitted
				// entirely when unset so re-auth PUTs stay byte-identical.
				...(options?.resources ? { resources: options.resources } : {}),
			}),
		},
		fetchImpl,
	)

	await checkResponse(resp, url)

	const data = await resp.json().catch(() => {
		throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
	})

	const uri = data.uri
	if (typeof uri !== "string") {
		throw new RemoteNetworkError(`Missing uri in workspace response from ${endpoint}`)
	}

	return { uri, description: typeof data.description === "string" ? data.description : description }
}

export async function exchangeWorkspaceToken(
	apiKey: string,
	workspaceId: string,
	options?: AuthenticateOptions,
): Promise<{ token: string; expireTime: string }> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/workspace-tokens:exchange`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ workspaceId: workspaceId }),
		},
		fetchImpl,
	)

	await checkResponse(resp, url)

	const data = await resp.json().catch(() => {
		throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
	})

	const token = data.token
	const expireTime = data.expireTime
	if (typeof token !== "string") {
		throw new RemoteNetworkError(`Missing token in exchange response from ${endpoint}`)
	}

	return { token, expireTime: typeof expireTime === "string" ? expireTime : "" }
}
