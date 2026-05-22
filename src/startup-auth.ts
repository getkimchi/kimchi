import { authenticateViaBrowser } from "./cli-auth/index.js"

export type AuthReason = "missing" | "expired"

const MESSAGES: Record<AuthReason, string> = {
	missing: "No API key found. Let's get you logged in…",
	expired: "API key is invalid or expired. Let's re-authenticate…",
}

/**
 * Prompt the user to log in via the browser. Used at startup when no API
 * key is configured or when the existing key is rejected with a 401.
 *
 * @param reason - Why the login is needed (controls the user-facing message).
 * @returns The API key token on success.
 * @throws When the browser login flow fails or is cancelled by the user.
 */
export async function ensureAuthenticated(reason: AuthReason = "missing"): Promise<string> {
	console.log(MESSAGES[reason])
	try {
		const { token } = await authenticateViaBrowser()
		return token
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.error(`Login failed: ${message}`)
		console.error("You can try again later with 'kimchi login'.")
		throw err
	}
}
