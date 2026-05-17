/**
 * SSH ProxyCommand bridge.
 *
 * Usage in ~/.ssh/config:
 *   ProxyCommand kimchi --ssh-proxy %h
 *
 * `proxyConnect` is invoked with the sandbox hostname (e.g.
 * `frivolous-nifty-manticore-bdf07a-adfb.remote.kimchi.dev`), looks up the
 * matching session via the Kimchi API, exchanges a short-lived session token,
 * then splices process.stdin → WebSocket and WebSocket → process.stdout so
 * that OpenSSH (or any other SSH client) sees a transparent byte-stream.
 */

import { exchangeSessionToken, verifyApiKey } from "./auth.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"

// ─── Types & shared helpers ───────────────────────────────────────────────────

export interface ProxyConnectOptions {
	/**
	 * Override the remote endpoint.  Resolution order:
	 * 1. this option
	 * 2. `KIMCHI_REMOTE_ENDPOINT` env-var
	 * 3. production default `https://app.kimchi.dev/api`
	 */
	endpoint?: string
	/** Override global fetch (used by tests). */
	fetch?: typeof globalThis.fetch
	/** Override process.stdin (used by tests). */
	stdin?: NodeJS.ReadableStream
	/** Override process.stdout (used by tests). */
	stdout?: NodeJS.WritableStream
}

function resolveEndpoint(options?: ProxyConnectOptions): string {
	return options?.endpoint ?? process.env.KIMCHI_REMOTE_ENDPOINT ?? "https://app.kimchi.dev/api"
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	fetchImpl: typeof globalThis.fetch,
	ms = 30_000,
): Promise<Response> {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), ms)
	try {
		return await fetchImpl(url, { ...init, signal: ctrl.signal })
	} finally {
		clearTimeout(timer)
	}
}

// ─── Session lookup ───────────────────────────────────────────────────────────

interface SessionItem {
	id: string
	uri: string
}

interface ListSessionsPage {
	items: SessionItem[]
	nextPageCursor: string
}

/**
 * Walk the paginated `/sessions` list for `orgId` until a session whose
 * `uri` matches `sandboxUrl` is found.  Returns its session ID.
 *
 * Throws {@link RemoteAuthError} (404) when the URL is not found after
 * exhausting all pages.
 */
async function findSessionIdByUri(
	orgId: string,
	sandboxUrl: string,
	apiKey: string,
	options?: ProxyConnectOptions,
): Promise<string> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	let cursor = ""

	while (true) {
		const qs = cursor ? `?page.cursor=${encodeURIComponent(cursor)}` : ""
		const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/sessions${qs}`

		const resp = await fetchWithTimeout(
			url,
			{
				method: "GET",
				headers: { Authorization: `Bearer ${apiKey}` },
			},
			fetchImpl,
		)

		if (!resp.ok) {
			const body = await resp.text().catch(() => "")
			switch (resp.status) {
				case 401:
					throw new RemoteAuthError(`Invalid API key - run 'kimchi setup' to authenticate: ${endpoint}`, 401)
				case 403:
					throw new RemoteAuthError(
						`Forbidden - your API key does not have permission to list sessions. ${endpoint}`,
						403,
					)
				default:
					throw new RemoteNetworkError(`HTTP ${resp.status} from ${url}${body ? `: ${body}` : ""}`)
			}
		}

		const page = (await resp.json().catch(() => {
			throw new RemoteNetworkError(`Unexpected non-JSON response from ${url}`)
		})) as ListSessionsPage

		const match = page.items?.find((s) => s.uri === sandboxUrl)
		if (match) return match.id

		cursor = page.nextPageCursor ?? ""
		if (!cursor) break
	}

	throw new RemoteAuthError(`No session found with URI '${sandboxUrl}'.`, 404)
}

// ─── Auth flow ────────────────────────────────────────────────────────────────

interface TunnelCredentials {
	/** The session's WebSocket URI, e.g. `wss://…/connect`. */
	wsUrl: string
	/** Short-lived bearer token for the WebSocket handshake. */
	token: string
}

/**
 * Full three-step flow:
 * 1. Verify API key → `organizationId`.
 * 2. Walk paginated session list until `sandboxUrl` matches a session `uri` → `sessionId`.
 * 3. Exchange for a short-lived session token.
 *
 * The WebSocket URL is constructed from the sandbox hostname (same scheme as
 * `transport-ws.ts`: `wss://{uri}/connect`).
 */
async function resolveTunnelCredentials(
	sandboxUrl: string,
	apiKey: string,
	options?: ProxyConnectOptions,
): Promise<TunnelCredentials> {
	const authOptions = { endpoint: resolveEndpoint(options), fetch: options?.fetch ?? globalThis.fetch }

	const orgId = await verifyApiKey(apiKey, authOptions)
	const sessionId = await findSessionIdByUri(orgId, sandboxUrl, apiKey, options)
	const { token } = await exchangeSessionToken(apiKey, sessionId, authOptions)

	return {
		wsUrl: `wss://${sandboxUrl}/ssh`,
		token,
	}
}

// ─── WebSocket binary bridge ──────────────────────────────────────────────────

/**
 * Open a WebSocket to the sandbox SSH tunnel and splice it with
 * stdin/stdout so that an SSH client can use this process as a ProxyCommand.
 *
 * Every chunk read from stdin is sent as a single binary WebSocket message.
 * Every binary (or text) message received from the WebSocket is written
 * verbatim to stdout.  The process exits when the WebSocket closes.
 */
async function runBinaryBridge(wsUrl: string, token: string, options?: ProxyConnectOptions): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: accessing globalThis WebSocket
	const WS = (globalThis as any).WebSocket
	if (!WS) {
		throw new Error("WebSocket is not available. Node 22+ is required for --ssh-proxy.")
	}

	const stdin: NodeJS.ReadableStream = options?.stdin ?? process.stdin
	const stdout: NodeJS.WritableStream = options?.stdout ?? process.stdout

	const ws = new WS(wsUrl, { headers: { Authorization: `Bearer ${token}` } })

	// Receive WebSocket messages → stdout
	ws.addEventListener("message", (ev: MessageEvent) => {
		const data: unknown = ev.data
		if (data instanceof ArrayBuffer) {
			stdout.write(Buffer.from(data))
		} else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
			stdout.write(data as Buffer)
		} else if (typeof data === "string") {
			stdout.write(data)
		} else {
			// Blob (browser-only) or other — convert via string
			stdout.write(String(data))
		}
	})

	// Wait for the socket to open before wiring stdin
	await new Promise<void>((resolve, reject) => {
		if (ws.readyState === WS.OPEN) {
			resolve()
			return
		}
		const onOpen = () => {
			cleanup()
			resolve()
		}
		const onError = (ev: ErrorEvent) => {
			cleanup()
			reject(new Error(`WebSocket connection failed: ${ev.error?.message ?? "unknown"}`))
		}
		const onClose = () => {
			cleanup()
			reject(new Error("WebSocket closed before opening"))
		}
		const cleanup = () => {
			ws.removeEventListener("open", onOpen)
			ws.removeEventListener("error", onError)
			ws.removeEventListener("close", onClose)
		}
		ws.addEventListener("open", onOpen, { once: true })
		ws.addEventListener("error", onError, { once: true })
		ws.addEventListener("close", onClose, { once: true })
	})

	// stdin → WebSocket binary messages
	stdin.on("data", (chunk: Buffer | string) => {
		if (ws.readyState === WS.OPEN) {
			ws.send(
				typeof chunk === "string" ? chunk : chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
			)
		}
	})

	// Close WebSocket when stdin ends (SSH client disconnected)
	stdin.on("end", () => {
		if (ws.readyState !== WS.CLOSED && ws.readyState !== WS.CLOSING) {
			ws.close(1000, "stdin closed")
		}
	})

	// Ensure stdin is flowing so we don't miss data
	if ((stdin as NodeJS.ReadableStream & { resume?: () => void }).resume) {
		;(stdin as NodeJS.ReadableStream & { resume: () => void }).resume()
	}

	// Await WebSocket close → propagate non-normal close as exit code 1
	await new Promise<void>((resolve) => {
		ws.addEventListener("close", (ev: CloseEvent) => {
			if (ev.code !== 1000) {
				process.exitCode = 1
			}
			resolve()
		})
	})
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Resolve `sandboxUrl` to a WebSocket SSH tunnel via the Kimchi API, then
 * bridge the connection over stdin/stdout for use as an SSH ProxyCommand.
 *
 * @param sandboxUrl  The sandbox hostname passed as `%h` by SSH
 *                    (e.g. `frivolous-nifty-manticore-bdf07a-adfb.remote.kimchi.dev`).
 * @param apiKey      Kimchi API key used to authenticate.
 * @param options     Optional overrides for endpoint, fetch, stdin, stdout.
 */
export async function proxyConnect(sandboxUrl: string, apiKey: string, options?: ProxyConnectOptions): Promise<void> {
	const { wsUrl, token } = await resolveTunnelCredentials(sandboxUrl, apiKey, options)
	await runBinaryBridge(wsUrl, token, options)
}
