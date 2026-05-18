import { randomBytes } from "node:crypto"
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http"

const CALLBACK_PATH = "/callback"
const CALLBACK_TIMEOUT_MS = 300_000 // 5 minutes

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

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authentication Successful</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: #0f172a;
      color: #e2e8f0;
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 420px;
    }
    .icon {
      width: 64px;
      height: 64px;
      margin: 0 auto 1.5rem;
      background: #10b981;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: #fff;
    }
    p {
      color: #94a3b8;
      line-height: 1.6;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">&#10003;</div>
    <h1>Authentication Successful</h1>
    <p>Your CLI is now connected. You can close this window and start using Kimchi.</p>
  </div>
</body>
</html>`

function escapeHtml(unsafe: string): string {
	return unsafe
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;")
}

function htmlError(message: string, details?: string): string {
	const detailBlock = details
		? `<div style="margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; font-family: monospace; font-size: 0.875rem; color: #fca5a5; word-break: break-word;">${escapeHtml(details)}</div>`
		: ""
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="5;url=about:blank" />
  <title>Authentication Failed</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: #0f172a;
      color: #e2e8f0;
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 420px;
    }
    .icon {
      width: 64px;
      height: 64px;
      margin: 0 auto 1.5rem;
      background: #ef4444;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: #fff;
    }
    p {
      color: #94a3b8;
      line-height: 1.6;
      margin: 0 0 1.5rem;
    }
    .timer {
      color: #64748b;
      font-size: 0.875rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">&#10007;</div>
    <h1>Authentication Failed</h1>
    <p>${escapeHtml(message)}</p>
    ${detailBlock}
  </div>
  <script>setTimeout(() => window.close(), 5000);</script>
</body>
</html>`
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
					res.end(htmlError("Forbidden", "Only localhost connections are allowed."))
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
					res.end(htmlError("Login error", errorMsg))
					finish({ error: errorMsg })
					return
				}

				// Check for error first
				const error = url.searchParams.get("error")
				const errorDescription = url.searchParams.get("error_description")
				if (error) {
					const errorMsg = errorDescription || error
					res.writeHead(200, { "Content-Type": "text/html", Connection: "close" })
					res.end(htmlError("Authentication failed", errorMsg))
					finish({ error: errorMsg })
					return
				}

				// Extract token
				const token = url.searchParams.get("token")
				if (!token) {
					const errorMsg = "No token was returned by the authentication server"
					res.writeHead(400, { "Content-Type": "text/html", Connection: "close" })
					res.end(htmlError("Missing token", errorMsg))
					finish({ error: errorMsg })
					return
				}

				// Success
				res.writeHead(200, { "Content-Type": "text/html", Connection: "close" })
				res.end(HTML_SUCCESS)
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
