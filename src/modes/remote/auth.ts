import {
	type AuthenticateResponse,
	RemoteAuthError,
	RemoteNetworkError,
	type RemoteSessionStatus,
	type RemoteSessionSummary,
} from "./types.js"

import { WebSocket } from "ws"

export interface AuthenticateOptions {
	/**
	 * Override the remote endpoint (used by tests).  Resolution order:
	 * 1. this option
	 * 2. `KIMCHI_REMOTE_ENDPOINT` env-var (for dev / mock-server testing)
	 * 3. production default `https://app.kimchi.dev`
	 */
	endpoint?: string
	/**
	 * Override global fetch (used by tests).
	 */
	fetch?: typeof globalThis.fetch
}

function resolveEndpoint(options?: AuthenticateOptions): string {
	const fromEnv = process.env.KIMCHI_REMOTE_ENDPOINT
	return options?.endpoint ?? fromEnv ?? "https://app.kimchi.dev/api"
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	fetchImpl: typeof globalThis.fetch,
	ms = 30_000,
	externalSignal?: AbortSignal,
): Promise<Response> {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), ms)
	const signal = externalSignal ? AbortSignal.any([ctrl.signal, externalSignal]) : ctrl.signal
	try {
		return await fetchImpl(url, { ...init, signal })
	} finally {
		clearTimeout(timer)
	}
}

async function checkResponse(resp: Response, endpoint: string): Promise<void> {
	if (resp.ok) return

	const body = await resp.text().catch(() => "")
	switch (resp.status) {
		case 401:
			throw new RemoteAuthError(`Invalid API key - run 'kimchi setup' to authenticate: ${endpoint}`, 401)
		case 403:
			throw new RemoteAuthError(
				`Forbidden - your API key does not have permission to use remote sessions. ${endpoint}`,
				403,
			)
		case 404:
			throw new RemoteAuthError(`Session not found or endpoint not available. ${endpoint}`, 404)
		case 409:
			throw new RemoteAuthError(`Session conflict - another client may already own this session. ${endpoint}`, 409)
		default: {
			throw new RemoteNetworkError(`HTTP ${resp.status} from ${endpoint}${body ? `: ${body}` : ""}`)
		}
	}
}

async function verifyApiKey(apiKey: string, options?: AuthenticateOptions): Promise<string> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/api-keys:verify`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
		},
		fetchImpl,
	)

	await checkResponse(resp, url)

	const data = await resp.json().catch(() => {
		throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
	})

	const orgId = data.organizationId
	if (typeof orgId !== "string") {
		throw new RemoteNetworkError(`Missing organizationId in verify response from ${endpoint}`)
	}

	return orgId
}

async function createOrUpdateSession(
	orgId: string,
	sessionId: string,
	apiKey: string,
	description: string,
	options?: AuthenticateOptions,
): Promise<{ uri: string; description: string }> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "PUT",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ description, options: { agentApiKey: apiKey } }),
		},
		fetchImpl,
	)

	await checkResponse(resp, url)

	const data = await resp.json().catch(() => {
		throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
	})

	const uri = data.uri
	if (typeof uri !== "string") {
		throw new RemoteNetworkError(`Missing uri in session response from ${endpoint}`)
	}

	return { uri, description: typeof data.description === "string" ? data.description : description }
}

async function exchangeSessionToken(
	apiKey: string,
	sessionId: string,
	options?: AuthenticateOptions,
): Promise<{ token: string; expireTime: string }> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/session-tokens:exchange`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sessionId }),
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

/**
 * Three-step authentication flow:
 * 1. Verify API key → organizationId.
 * 2. Create or update session → get WebSocket URI.
 * 3. Exchange for session token → get JWT for WebSocket auth.
 *
 * Keeps the same {@link AuthenticateResponse} shape so reconnect.ts and
 * transport-ws.ts do not need to change.
 */
export async function authenticateRemoteSession(
	sessionId: string,
	apiKey: string,
	description: string,
	options?: AuthenticateOptions,
): Promise<AuthenticateResponse> {
	const fetchImpl = options?.fetch ?? globalThis.fetch

	try {
		const orgId = await verifyApiKey(apiKey, { ...options, fetch: fetchImpl })
		const session = await createOrUpdateSession(orgId, sessionId, apiKey, description, {
			...options,
			fetch: fetchImpl,
		})
		const { token, expireTime } = await exchangeSessionToken(apiKey, sessionId, { ...options, fetch: fetchImpl })

		const { wsUrl, host } = normalizeWsUri(session.uri)

		return {
			connectToken: token,
			expiresAt: expireTime,
			wsUrl,
			host,
			description: session.description,
		}
	} catch (err) {
		if (err instanceof RemoteAuthError || err instanceof RemoteNetworkError) {
			throw err
		}
		throw new RemoteNetworkError(err instanceof Error ? err.message : String(err))
	}
}

function normalizeWsUri(raw: string): { wsUrl: string; host: string; port: number } {
	const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i)
	if (schemeMatch && !/^wss?$/i.test(schemeMatch[1])) {
		throw new RemoteNetworkError(`Unexpected protocol "${schemeMatch[1]}:" in server URI: ${raw}`)
	}
	const withScheme = schemeMatch ? raw : `wss://${raw}`
	let url: URL
	try {
		url = new URL(withScheme)
	} catch {
		throw new RemoteNetworkError(`Invalid WebSocket URI from server: ${raw}`)
	}
	if (url.protocol !== "wss:" && url.protocol !== "ws:") {
		throw new RemoteNetworkError(`Unexpected protocol "${url.protocol}" in server URI: ${raw}`)
	}
	const defaultPort = url.protocol === "wss:" ? 443 : 80
	const port = url.port ? Number(url.port) : defaultPort
	if (!Number.isFinite(port) || port <= 0) {
		throw new RemoteNetworkError(`Invalid port in WebSocket URI: ${raw}`)
	}
	const portStr = url.port && Number(url.port) !== defaultPort ? `:${url.port}` : ""
	const pathStr = url.pathname && url.pathname !== "/" ? url.pathname : ""
	return {
		wsUrl: `${url.protocol}//${url.hostname}${portStr}${pathStr}`,
		host: url.hostname,
		port,
	}
}

export interface MeResponse {
	id: string
	username?: string
	name?: string
	email?: string
}

export async function getMe(apiKey: string, options?: AuthenticateOptions): Promise<MeResponse> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/v1/me`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
		},
		fetchImpl,
	)

	await checkResponse(resp, url)

	const data = await resp.json().catch(() => {
		throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
	})

	if (typeof data?.id !== "string" || data.id.length === 0) {
		throw new RemoteNetworkError(`Missing id in /v1/me response from ${endpoint}`)
	}

	return data as MeResponse
}

export interface ListRemoteSessionsOptions extends AuthenticateOptions {
	signal?: AbortSignal
	creatorId?: string
}

const LIST_SESSIONS_PAGE_LIMIT = 200
const LIST_SESSIONS_PAGE_HARD_CAP = 10

export async function listRemoteSessions(
	apiKey: string,
	options?: ListRemoteSessionsOptions,
): Promise<RemoteSessionSummary[]> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)
	const signal = options?.signal
	const creatorId = options?.creatorId

	try {
		const orgId = await verifyApiKey(apiKey, { ...options, fetch: fetchImpl })

		const results: RemoteSessionSummary[] = []
		let cursor = ""

		for (let page = 0; page < LIST_SESSIONS_PAGE_HARD_CAP; page++) {
			const params = new URLSearchParams()
			params.set("page.limit", String(LIST_SESSIONS_PAGE_LIMIT))
			if (cursor) params.set("page.cursor", cursor)
			if (creatorId) params.set("creatorId", creatorId)

			const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/sessions?${params.toString()}`
			const resp = await fetchWithTimeout(
				url,
				{
					method: "GET",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						Accept: "application/json",
					},
				},
				fetchImpl,
				30_000,
				signal,
			)

			await checkResponse(resp, url)

			const bodyText = await resp.text()
			let data: unknown
			try {
				data = JSON.parse(bodyText)
			} catch {
				console.error(`listRemoteSessions: non-JSON response from ${url}: ${bodyText.slice(0, 500)}`)
				throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
			}

			if (typeof data !== "object" || data === null) {
				throw new RemoteNetworkError(`Unexpected response shape from ${endpoint}`)
			}

			const items = (data as { items?: unknown }).items
			if (!Array.isArray(items)) {
				console.error(`listRemoteSessions: missing items array from ${url}: ${bodyText.slice(0, 500)}`)
				throw new RemoteNetworkError(`Missing items array in list-sessions response from ${endpoint}`)
			}

			for (const item of items) {
				results.push(mapSessionToSummary(item, endpoint))
			}

			const nextCursor = (data as { nextPageCursor?: unknown }).nextPageCursor
			if (typeof nextCursor !== "string" || nextCursor.length === 0) {
				return results
			}
			cursor = nextCursor
		}

		return results
	} catch (err) {
		if (err instanceof RemoteAuthError || err instanceof RemoteNetworkError) {
			throw err
		}
		throw new RemoteNetworkError(err instanceof Error ? err.message : String(err))
	}
}

function mapSessionToSummary(raw: unknown, endpoint: string): RemoteSessionSummary {
	if (typeof raw !== "object" || raw === null) {
		throw new RemoteNetworkError(`Invalid session entry in list-sessions response from ${endpoint}`)
	}
	const r = raw as Record<string, unknown>

	const id = r.id
	if (typeof id !== "string" || id.length === 0) {
		throw new RemoteNetworkError(`Missing session id in list-sessions response from ${endpoint}`)
	}

	const createTime = r.createTime
	if (typeof createTime !== "string") {
		throw new RemoteNetworkError(`Missing createTime for session ${id} from ${endpoint}`)
	}
	const createdAt = new Date(createTime)
	if (Number.isNaN(createdAt.getTime())) {
		throw new RemoteNetworkError(`Invalid createTime "${createTime}" for session ${id} from ${endpoint}`)
	}

	const name = typeof r.description === "string" ? r.description : ""
	const status = mapSessionStatus(r.status)

	let host: string | undefined
	if (typeof r.uri === "string") {
		try {
			host = normalizeWsUri(r.uri).host
		} catch {
			host = undefined
		}
	}

	// Server proto has no last_activity_time / has_connected_client fields yet — placeholder for v1.
	return {
		id,
		name,
		createdAt,
		lastActivityAt: createdAt,
		status,
		hasConnectedClient: false,
		host,
	}
}

function mapSessionStatus(raw: unknown): RemoteSessionStatus {
	switch (raw) {
		case "ACTIVE":
		case "INITIALIZING":
			return "active"
		case "DELETING":
			return "completed"
		default:
			return "idle"
	}
}

export interface WaitForSessionReadyOptions {
	connectToken: string
	wsUrl: string
	signal?: AbortSignal
	timeoutMs?: number
	pollIntervalMs?: number
	probeTimeoutMs?: number
	wsPath?: string
	onTick?: (info: { elapsedMs: number; lastError?: string }) => void
	// biome-ignore lint/suspicious/noExplicitAny: tests inject a fake WebSocket constructor
	_WebSocket?: any
}

const DEFAULT_READY_TIMEOUT_MS = 90_000
const DEFAULT_POLL_INTERVAL_MS = 1_500
const DEFAULT_PROBE_TIMEOUT_MS = 5_000
const DEFAULT_WS_PATH = "/connect"

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup()
			resolve()
		}, ms)
		const onAbort = () => {
			cleanup()
			clearTimeout(timer)
			reject(new RemoteNetworkError("Aborted while waiting for session to become ready"))
		}
		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort)
		}
		if (signal?.aborted) {
			cleanup()
			clearTimeout(timer)
			reject(new RemoteNetworkError("Aborted while waiting for session to become ready"))
			return
		}
		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

/**
 * Probe the WS endpoint once. Resolves with `{ ready: true }` if the upgrade
 * completes, `{ ready: false, error }` otherwise. Never throws.
 *
 * Implementation note: we open the WS, wait for `open` (ready), `close` (not
 * ready — the agentgateway returned non-101 or closed mid-handshake), `error`
 * (network error), or a per-probe timeout. The WS is always closed before we
 * return so we don't accumulate connections during the polling loop.
 */
function probeSessionWsOnce(opts: {
	connectToken: string
	wsURL: string
	wsPath: string
	probeTimeoutMs: number
	signal?: AbortSignal
	// biome-ignore lint/suspicious/noExplicitAny: injectable WebSocket constructor
	WS: any
}): Promise<{ ready: boolean; error?: string }> {
	return new Promise((resolve) => {
		let settled = false
		const settle = (result: { ready: boolean; error?: string }) => {
			if (settled) return
			settled = true
			cleanup()
			try {
				ws.close()
			} catch {
				// ignore
			}
			resolve(result)
		}

		const url = `${opts.wsURL}${opts.wsPath}`
		const headers = { Authorization: `Bearer ${opts.connectToken}` }
		let ws: { close(): void; addEventListener: (t: string, cb: (e: unknown) => void) => void }
		try {
			ws = new opts.WS(url, { headers })
		} catch (err) {
			resolve({ ready: false, error: err instanceof Error ? err.message : String(err) })
			return
		}

		const timer = setTimeout(() => settle({ ready: false, error: "probe timeout" }), opts.probeTimeoutMs)
		const onAbort = () => settle({ ready: false, error: "aborted" })
		const cleanup = () => {
			clearTimeout(timer)
			opts.signal?.removeEventListener("abort", onAbort)
		}

		if (opts.signal?.aborted) {
			settle({ ready: false, error: "aborted" })
			return
		}
		opts.signal?.addEventListener("abort", onAbort, { once: true })

		ws.addEventListener("open", () => settle({ ready: true }))
		ws.addEventListener("error", (e: unknown) => {
			const msg = (e as { message?: string })?.message ?? "websocket error"
			settle({ ready: false, error: msg })
		})
		ws.addEventListener("close", (e: unknown) => {
			const code = (e as { code?: number })?.code
			const reason = (e as { reason?: string })?.reason
			settle({ ready: false, error: code ? `closed code=${code}${reason ? ` reason=${reason}` : ""}` : "closed" })
		})
	})
}

/**
 * Poll a WebSocket probe to `wss://<host>:<port>/connect` until the upgrade
 * succeeds, which signals that the agentgateway has attached the session
 * policy and traffic is routable. Replaces a previous status-API poll because
 * the `:get_session` HTTP path is unreliable; the WS upgrade is the canonical
 * signal we actually care about.
 */
export async function waitForSessionReady(options: WaitForSessionReadyOptions): Promise<void> {
	const signal = options.signal
	const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
	const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
	const wsPath = options.wsPath ?? DEFAULT_WS_PATH
	const WS = options._WebSocket ?? WebSocket

	const startedAt = Date.now()
	let lastError: string | undefined

	while (true) {
		if (signal?.aborted) {
			throw new RemoteNetworkError("Aborted while waiting for session to become ready")
		}
		const elapsedMs = Date.now() - startedAt
		if (elapsedMs > timeoutMs) {
			throw new RemoteNetworkError(
				`Session did not become ready within ${Math.round(timeoutMs / 1000)}s (last probe: ${lastError ?? "unknown"})`,
			)
		}

		const probe = await probeSessionWsOnce({
			connectToken: options.connectToken,
			wsURL: options.wsUrl,
			wsPath,
			probeTimeoutMs,
			signal,
			WS,
		})

		options.onTick?.({ elapsedMs, lastError: probe.error })

		if (probe.ready) return
		lastError = probe.error

		await sleep(pollIntervalMs, signal)
	}
}
