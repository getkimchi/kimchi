/**
 * MCP OAuth Callback Server
 *
 * HTTP server that handles OAuth callbacks from the authorization server.
 * Uses Node.js http module for compatibility.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { oauthErrorHtml, oauthSuccessHtml } from "../../utils/oauth-page.js"
import {
	getConfiguredOAuthCallbackPort,
	getOAuthCallbackPort,
	OAUTH_CALLBACK_PATH,
	setOAuthCallbackPort,
} from "./mcp-oauth-provider.js"

// Branded OAuth callback pages come from the shared renderer (templates in
// resources/oauth/, via KIMCHI_OAUTH_TEMPLATE_DIR); it also HTML-escapes the
// provider-controlled error text. Falls back to a minimal unbranded page when
// the template dir is not configured.
const SUCCESS_MESSAGE = "You can close this window and return to Kimchi."
const SUCCESS_PAGE = { title: "MCP Authorization Successful", heading: "MCP Authorization Successful" }
const ERROR_MESSAGE = "An error occurred during MCP authorization."
const ERROR_PAGE = { title: "MCP Authorization Failed", heading: "MCP Authorization Failed" }

/** Pending authorization request */
interface PendingAuth {
	resolve: (code: string) => void
	reject: (error: Error) => void
	timeout: ReturnType<typeof setTimeout>
}

/** Server singleton state */
let server: Server | undefined
const pendingAuths = new Map<string, PendingAuth>()
let serverLifecycle = Promise.resolve()

function serializeServerLifecycle(operation: () => Promise<void>): Promise<void> {
	const result = serverLifecycle.then(operation, operation)
	serverLifecycle = result.catch(() => {})
	return result
}

/** Timeout for callback completion (5 minutes) */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

const MAX_PORT_SCAN_ATTEMPTS = 25

interface EnsureCallbackServerOptions {
	strictPort?: boolean
}

/**
 * Handle incoming HTTP requests to the callback server.
 */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
	const url = new URL(req.url || "/", `http://${req.headers.host}`)

	// Only handle the callback path
	if (url.pathname !== OAUTH_CALLBACK_PATH) {
		res.writeHead(404, { "Content-Type": "text/plain" })
		res.end("Not found")
		return
	}

	const code = url.searchParams.get("code")
	const state = url.searchParams.get("state")
	const error = url.searchParams.get("error")
	const errorDescription = url.searchParams.get("error_description")

	// Enforce state parameter presence for CSRF protection
	if (!state) {
		const errorMsg = "Missing required state parameter - potential CSRF attack"
		res.writeHead(400, { "Content-Type": "text/html" })
		res.end(oauthErrorHtml(ERROR_MESSAGE, errorMsg, ERROR_PAGE))
		return
	}

	// Handle OAuth errors
	if (error) {
		const errorMsg = errorDescription || error
		// Send HTTP response first before rejecting promise
		res.writeHead(200, { "Content-Type": "text/html" })
		res.end(oauthErrorHtml(ERROR_MESSAGE, errorMsg, ERROR_PAGE))
		// Reject promise after response is sent (defer to allow test to attach handler)
		if (pendingAuths.has(state)) {
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			const pending = pendingAuths.get(state)!
			clearTimeout(pending.timeout)
			pendingAuths.delete(state)
			setTimeout(() => pending.reject(new Error(errorMsg)), 0)
		}
		return
	}

	// Require authorization code
	if (!code) {
		res.writeHead(400, { "Content-Type": "text/html" })
		res.end(oauthErrorHtml(ERROR_MESSAGE, "No authorization code provided", ERROR_PAGE))
		// Reject the pending auth so the flow fails fast instead of hanging until the timeout
		if (pendingAuths.has(state)) {
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			const pending = pendingAuths.get(state)!
			clearTimeout(pending.timeout)
			pendingAuths.delete(state)
			setTimeout(() => pending.reject(new Error("No authorization code provided")), 0)
		}
		return
	}

	// Validate state parameter
	if (!pendingAuths.has(state)) {
		const errorMsg = "Invalid or expired state parameter - potential CSRF attack"
		res.writeHead(400, { "Content-Type": "text/html" })
		res.end(oauthErrorHtml(ERROR_MESSAGE, errorMsg, ERROR_PAGE))
		return
	}

	// biome-ignore lint/style/noNonNullAssertion: asserted above
	const pending = pendingAuths.get(state)!

	// Clear timeout and resolve the pending promise
	clearTimeout(pending.timeout)
	pendingAuths.delete(state)
	pending.resolve(code)

	res.writeHead(200, { "Content-Type": "text/html" })
	res.end(oauthSuccessHtml(SUCCESS_MESSAGE, SUCCESS_PAGE))
}

/**
 * Ensure the callback server is running.
 * If strictPort is true, requires binding on the configured callback port.
 * If strictPort is false, scans forward for an available local port.
 */
async function ensureCallbackServerLocked(options: EnsureCallbackServerOptions): Promise<void> {
	const configuredPort = getConfiguredOAuthCallbackPort()
	const strictPort = options.strictPort === true

	if (server) {
		if (!strictPort || getOAuthCallbackPort() === configuredPort) return

		if (pendingAuths.size > 0) {
			throw new Error(
				`OAuth callback server is running on port ${getOAuthCallbackPort()}, but strict callback port ${configuredPort} is required and cannot be switched while authorizations are pending`,
			)
		}

		await stopCallbackServerLocked()
	}

	const preferredPort = configuredPort
	const maxAttempts = strictPort ? 1 : MAX_PORT_SCAN_ATTEMPTS
	let lastError: Error | undefined

	for (let offset = 0; offset < maxAttempts; offset++) {
		const candidatePort = preferredPort + offset
		const candidateServer = createServer(handleRequest)

		try {
			await new Promise<void>((resolve, reject) => {
				candidateServer.once("error", (err) => {
					reject(err)
				})

				candidateServer.listen(candidatePort, "127.0.0.1", () => {
					resolve()
				})
			})

			server = candidateServer
			server.unref()
			setOAuthCallbackPort(candidatePort)
			return
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException
			await new Promise<void>((resolve) => {
				candidateServer.close(() => resolve())
			})

			if (nodeError.code !== "EADDRINUSE") {
				throw error
			}

			lastError = error instanceof Error ? error : new Error(String(error))
		}
	}

	if (strictPort) {
		throw new Error(
			`OAuth callback port ${preferredPort} is already in use. Pre-registered OAuth clients require an exact redirect URI; set MCP_OAUTH_CALLBACK_PORT to your registered port or free port ${preferredPort}`,
			{ cause: lastError },
		)
	}

	throw new Error(
		`OAuth callback port ${preferredPort} is already in use and no free port was found in range ${preferredPort}-${preferredPort + MAX_PORT_SCAN_ATTEMPTS - 1}`,
		{ cause: lastError },
	)
}

export function ensureCallbackServer(options: EnsureCallbackServerOptions = {}): Promise<void> {
	return serializeServerLifecycle(() => ensureCallbackServerLocked(options))
}

export async function prepareCallback(
	oauthState: string,
	options: EnsureCallbackServerOptions = {},
): Promise<{ callbackPromise: Promise<string> }> {
	let callbackPromise: Promise<string> | undefined
	await serializeServerLifecycle(async () => {
		await ensureCallbackServerLocked(options)
		callbackPromise = waitForCallback(oauthState)
	})
	if (!callbackPromise) throw new Error("OAuth callback registration failed")
	return { callbackPromise }
}

/**
 * Wait for a callback with the given OAuth state.
 * Returns a promise that resolves with the authorization code.
 */
export function waitForCallback(oauthState: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (pendingAuths.has(oauthState)) {
				pendingAuths.delete(oauthState)
				reject(new Error("OAuth callback timeout - authorization took too long"))
			}
		}, CALLBACK_TIMEOUT_MS)

		pendingAuths.set(oauthState, { resolve, reject, timeout })
	})
}

/**
 * Cancel a pending authorization by state.
 */
export function cancelPendingCallback(oauthState: string): void {
	const pending = pendingAuths.get(oauthState)
	if (pending) {
		clearTimeout(pending.timeout)
		pendingAuths.delete(oauthState)
		pending.reject(new Error("Authorization cancelled"))
	}
}

/**
 * Stop the callback server and reject all pending authorizations.
 */
async function stopCallbackServerLocked(): Promise<void> {
	if (server) {
		await new Promise<void>((resolve) => {
			server?.close(() => {
				resolve()
			})
		})
		server = undefined
	}

	setOAuthCallbackPort(getConfiguredOAuthCallbackPort())

	// Reject all pending auths (defer to allow any pending operations to complete)
	const pendingList = Array.from(pendingAuths.entries())
	pendingAuths.clear()
	setTimeout(() => {
		for (const [, pending] of pendingList) {
			clearTimeout(pending.timeout)
			pending.reject(new Error("OAuth callback server stopped"))
		}
	}, 0)
}

export function stopCallbackServer(): Promise<void> {
	return serializeServerLifecycle(stopCallbackServerLocked)
}

/**
 * Check if the callback server is running.
 */
export function isCallbackServerRunning(): boolean {
	return server !== undefined
}

/**
 * Get the number of pending authorizations.
 */
export function getPendingAuthCount(): number {
	return pendingAuths.size
}
