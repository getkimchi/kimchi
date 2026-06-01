import { randomBytes } from "node:crypto"
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http"
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js"

const CALLBACK_PATH = "/callback"
const CALLBACK_TIMEOUT_MS = 300_000 // 5 minutes
const SUCCESS_MESSAGE = "Your CLI is now connected. You can close this window and start using Kimchi."

export interface CallbackResult {
	token?: string
	error?: string
}

export interface CallbackServer {
	port: number
	url: string
	result: Promise<CallbackResult>
	close: () => void
}

/**
 * Start a temporary HTTP server on localhost to receive the token callback
 * from the browser.
 *
 * - Binds only on 127.0.0.1 for security
 * - Validates the `state` parameter against CSRF
 * - Returns a success or error HTML page to the browser
 * - Times out after 5 minutes if no callback arrives
 */
export function startCallbackServer(expectedState: string): Promise<CallbackServer> {
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

				// Validate state parameter for CSRF protection
				const state = url.searchParams.get("state")
				if (!state || state !== expectedState) {
					const errorMsg = "This request isn't valid. Please try logging in again from your terminal."
					res.writeHead(400, { "Content-Type": "text/html", Connection: "close" })
					res.end(oauthErrorHtml("Login error", errorMsg))
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
					finish({ error: errorMsg })
					return
				}

				// Extract token
				const token = url.searchParams.get("token")
				if (!token) {
					const errorMsg = "No token was returned by the authentication server"
					res.writeHead(400, { "Content-Type": "text/html", Connection: "close" })
					res.end(oauthErrorHtml("Missing token", errorMsg))
					finish({ error: errorMsg })
					return
				}

				// Success
				res.writeHead(200, { "Content-Type": "text/html", Connection: "close" })
				res.end(oauthSuccessHtml(SUCCESS_MESSAGE))
				finish({ token })
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" })
				res.end("Internal server error")
				finish({ error: `Unexpected server error: ${message}` })
				req.socket.destroy()
			}
		}

		server = createServer(onRequest)

		server.listen(0, "127.0.0.1", () => {
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
				url: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
				result: resultPromise,
				close: () => {
					finish({ error: "Login cancelled" })
				},
			})
		})

		server.on("error", (err) => {
			closeServer()
			rejectStart(err)
		})
	})
}

/**
 * Generate a random state string for CSRF protection.
 */
export function generateState(): string {
	return randomBytes(32).toString("hex")
}
