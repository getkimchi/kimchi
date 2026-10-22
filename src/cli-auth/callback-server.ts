import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { oauthErrorHtml, oauthSuccessHtml } from "../utils/oauth-page.js"

const CALLBACK_PATH = "/callback"
const CALLBACK_TIMEOUT_MS = 300_000 // 5 minutes
// Default success copy for terminal-initiated logins (`kimchi login`). Flows
// launched by other clients override it via CallbackServerOptions.
const SUCCESS_MESSAGE = "Your CLI is now connected. You can close this window and start using Kimchi."

export type CallbackMode = "token" | "code"

export interface CallbackServerOptions {
	/** Copy shown on the success page. Defaults to the terminal CLI message. */
	successMessage?: string
	/** What the callback URL is expected to deliver. Defaults to "token" for
	 * the legacy `castai_v1_` API-key handoff. OAuth flows pass "code". */
	mode?: CallbackMode
	/** Port selection. Fixed-port callers must also pre-reserve it (e.g. by
	 * accepting the risk of EADDRINUSE on a busy developer machine). */
	port?: { kind: "fixed"; value: number } | { kind: "ephemeral" }
}

/** A single fixed port is registered with Auth0; tests cannot assume it is
 * free (another Kimchi session may legitimately hold it mid-login), so the
 * production SSO constant is exported for the SSO login and the test suite
 * uses ephemeral ports via the CallbackServerOptions seam. */
export const CAST_AI_SSO_CALLBACK_PORT = 8765

/** Reusable port-in-use guidance for callers that pick `port.kind: "fixed"`. */
export function callbackPortInUseError(port: number): Error {
	return new Error(
		`Port ${port} is in use, probably by an unfinished CAST AI sign-in in another Kimchi session. Cancel that sign-in and try again.`,
	)
}

export interface CallbackResult {
	/** OAuth Authorization Code flow: the `code` query param. */
	code?: string
	/** Legacy `castai_v1_` key handoff: the `token` query param. */
	token?: string
	error?: string
	/** RFC 6749 `error` value when the IdP returned one (OAuth flows only). */
	errorCode?: string
}

export interface CallbackServer {
	port: number
	url: string
	result: Promise<CallbackResult>
	close: () => void
}

/**
 * Start a temporary HTTP server on localhost to receive the callback from the
 * browser (key handoff OR OAuth code). One implementation for both — the
 * `mode` option picks which query param the success path returns.
 *
 * - Binds only on 127.0.0.1 for security
 * - Validates the `state` parameter against CSRF
 * - Returns a success or error HTML page to the browser
 * - Times out after 5 minutes if no callback arrives
 */
export function startCallbackServer(
	expectedState: string,
	options: CallbackServerOptions = {},
): Promise<CallbackServer> {
	return new Promise<CallbackServer>((resolveStart, rejectStart) => {
		let server: Server | undefined
		let resolved = false
		let resolvedResult: CallbackResult | undefined
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined
		let resolveResult: ((r: CallbackResult) => void) | undefined

		function finish(result: CallbackResult) {
			if (resolved) return
			resolved = true
			resolvedResult = result
			if (timeoutTimer) clearTimeout(timeoutTimer)
			if (resolveResult) resolveResult(resolvedResult ?? { error: "Callback server closed unexpectedly" })
			// Defer socket destruction so the HTTP response has time to flush
			setTimeout(closeServer, 100)
		}

		function closeServer() {
			if (!server) return
			try {
				server?.closeAllConnections?.()
				server?.close?.()
			} catch {
				// Already closing or closed — safe to ignore
			}
			server = undefined
		}

		function onRequest(req: IncomingMessage, res: ServerResponse) {
			const mode: CallbackMode = options.mode ?? "token"
			try {
				const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)

				// Reject non-localhost connections
				const remote = req.socket.remoteAddress ?? ""
				// Only accept connections from the loopback interface
				if (!(remote.startsWith("127.") || remote === "::1" || remote === "::ffff:127.0.0.1")) {
					res.writeHead(403, { "Content-Type": "text/html", Connection: "close" })
					res.end(oauthErrorHtml("Forbidden", "Only localhost connections are allowed."))
					return
				}

				// Only handle the callback path
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404, { "Content-Type": "text/plain", Connection: "close" })
					res.end("Not found")
					return
				}

				// Validate state parameter for CSRF protection. OAuth flows surface
				// the standard RFC 6749 wording ("state mismatch") so callers can
				// match on it; the legacy token handoff keeps its gentler copy.
				const state = url.searchParams.get("state")
				if (!state || state !== expectedState) {
					const errorMsg =
						mode === "code"
							? "OAuth state mismatch — the sign-in attempt was rejected for your protection"
							: "This request isn't valid. Please try logging in again from your terminal."
					const heading = mode === "code" ? "Sign-in failed" : "Login error"
					res.writeHead(400, { "Content-Type": "text/html", Connection: "close" })
					res.end(oauthErrorHtml(heading, errorMsg))
					finish({ error: errorMsg })
					return
				}

				// Check for error first
				const error = url.searchParams.get("error")
				const errorDescription = url.searchParams.get("error_description")
				if (error) {
					const errorMsg = errorDescription || error
					res.writeHead(200, { "Content-Type": "text/html", Connection: "close" })
					res.end(oauthErrorHtml("Authentication failed", errorMsg))
					finish({ error: errorMsg, errorCode: error })
					return
				}

				// Extract the deliverable (token or code) based on the flow mode.
				const deliverable = mode === "code" ? url.searchParams.get("code") : url.searchParams.get("token")
				if (!deliverable) {
					const errorMsg =
						mode === "code"
							? "Missing authorization code in the OAuth callback"
							: "No token was returned by the authentication server"
					const pageTitle = mode === "code" ? "Missing code" : "Missing token"
					res.writeHead(400, { "Content-Type": "text/html", Connection: "close" })
					res.end(oauthErrorHtml(pageTitle, errorMsg))
					finish({ error: errorMsg })
					return
				}

				// Success
				res.writeHead(200, { "Content-Type": "text/html", Connection: "close" })
				res.end(oauthSuccessHtml(options.successMessage ?? SUCCESS_MESSAGE))
				finish(mode === "code" ? { code: deliverable } : { token: deliverable })
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" })
				res.end("Internal server error")
				finish({ error: `Unexpected server error: ${message}` })
				req.socket.destroy()
			}
		}

		server = createServer(onRequest)

		const portSelection = options.port ?? { kind: "ephemeral" as const }
		const fixedPort = portSelection.kind === "fixed" ? portSelection.value : 0

		server.once("error", (err) => {
			// A fixed-port caller hitting EADDRINUSE gets the same human-readable
			// message instead of a raw Node error. (Ephemeral-port callers
			// shouldn't normally hit this; fall through to the generic handler.)
			if (
				portSelection.kind === "fixed" &&
				err &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "EADDRINUSE"
			) {
				closeServer()
				rejectStart(callbackPortInUseError(fixedPort))
				return
			}
			closeServer()
			rejectStart(err)
		})

		server.listen(fixedPort, "127.0.0.1", () => {
			const addr = server?.address()
			if (!addr || typeof addr === "string") {
				closeServer()
				rejectStart(new Error("Could not determine callback server port"))
				return
			}

			const port = addr.port

			timeoutTimer = setTimeout(() => {
				finish({ error: "Browser login timed out -- please try again" })
			}, CALLBACK_TIMEOUT_MS)

			const resultPromise = new Promise<CallbackResult>((resolve) => {
				resolveResult = resolve
			})

			resolveStart({
				port,
				// OAuth flows must advertise `localhost` (the Auth0-registered
				// redirect URI host) so the IdP's exact-string-match on the
				// callback succeeds; the legacy token handoff keeps the raw
				// loopback IP, matching its pre-OAuth wiring.
				url: `http://${(options.mode ?? "token") === "code" ? "localhost" : "127.0.0.1"}:${port}${CALLBACK_PATH}`,
				result: resultPromise,
				close: () => {
					finish({ error: "Login cancelled" })
				},
			})
		})
	})
}

/**
 * Generate a random state string for CSRF protection.
 */
export function generateState(): string {
	return randomBytes(32).toString("hex")
}

/**
 * Alias for `generateState` exported under a more general name (the value
 * is opaque from the caller's perspective and OAuth flows use it the same
 * way as the key-handoff flow).
 */
export const generateOAuthState = generateState
