/**
 * CLI Browser Authentication Orchestration
 *
 * Starts a localhost callback server, opens the user's browser to the
 * Kimchi web app login page, and waits for the token to be delivered
 * back to the callback.
 */

import type { ChildProcess } from "node:child_process"
import open from "open"
import { envConfig } from "../config.js"
import { generateState, startCallbackServer } from "./callback-server.js"

export interface BrowserAuthOptions {
	/** Base URL of the Kimchi web app (default: https://app.kimchi.dev) */
	webAppUrl?: string
	/** Override for testing: bypass browser open and print URL instead */
	quiet?: boolean
	/** Injected open function for testing */
	_open?: (url: string) => Promise<ChildProcess | undefined>
	/** Optional callback to receive status messages instead of console.log */
	onMessage?: (message: string) => void
	/** Optional callback invoked with the browser URL before the browser opens */
	onBrowserUrl?: (url: string) => void
}

/**
 * Authenticate via browser.  The user is redirected to the Kimchi web
 * app, logs in if necessary, and the resulting API key is sent back to
 * a transient localhost callback server.
 *
 * @returns The raw API key token (e.g. "castai_v1_…")
 * @throws If the user cancels, the browser flow errors, or times out.
 */
export interface BrowserAuthResult {
	token: string
}

export async function authenticateViaBrowser(options: BrowserAuthOptions = {}): Promise<BrowserAuthResult> {
	const webAppUrl = options.webAppUrl ?? envConfig.KIMCHI_WEB_APP_URL
	const state = generateState()
	const log = options.onMessage ?? console.log

	const callbackServer = await startCallbackServer(state)

	try {
		const callbackUrl = encodeURIComponent(callbackServer.url)
		const browserUrl = `${webAppUrl}/cli-auth?callback=${callbackUrl}&state=${encodeURIComponent(state)}`

		log(`Kimchi login: ${browserUrl}`)
		options.onBrowserUrl?.(browserUrl)

		if (options.quiet) {
			log("If the browser did not open automatically, visit the URL above.")
		} else {
			log("Opening your browser to complete login…")
			const opener = options._open ?? open
			try {
				await opener(browserUrl)
			} catch {
				log("Couldn't open your browser automatically. Please visit the URL above manually.")
			}
		}

		const result = await callbackServer.result

		if (result.error) {
			throw new Error(`Browser login failed: ${result.error}`)
		}

		if (!result.token) {
			throw new Error("Browser login completed but no token was received")
		}

		callbackServer.close()
		return { token: result.token }
	} catch (err) {
		// Ensure the callback server is torn down on any error path
		callbackServer.close()
		throw err
	}
}
