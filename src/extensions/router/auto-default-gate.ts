/**
 * Gates the Auto-by-default rollout to @cast.ai accounts (internal dogfooding).
 *
 * `getMe` is awaited at startup (<=3s); on timeout or failure the gate reports
 * false, leaving the account on the existing multi-model default. The gate
 * controls only the fresh-session default — Auto stays selectable and
 * resumable for everyone.
 */

import { getMe } from "../../api/me.js"
import { loadConfig } from "../../config.js"

const CAST_AI_EMAIL_DOMAIN = "cast.ai"

/** Budget for the identity lookup; startup must not hang on a slow API. */
const LOOKUP_TIMEOUT_MS = 3000

let cachedIsCastAiUser: boolean | undefined
let lookupPromise: Promise<boolean> | undefined

/** @internal — exposed for testing only */
export function _resetAutoDefaultGateCache(): void {
	cachedIsCastAiUser = undefined
	lookupPromise = undefined
}

/**
 * Whether an email belongs to a cast.ai account.
 *
 * Compares the parsed domain exactly rather than suffix-matching, so neither
 * `user@notcast.ai` nor `user@sub.cast.ai` is treated as an internal account.
 */
export function isCastAiEmail(email: string | undefined): boolean {
	const normalized = email?.trim().toLowerCase()
	if (!normalized) return false
	const domain = normalized.slice(normalized.lastIndexOf("@") + 1)
	return normalized.includes("@") && domain === CAST_AI_EMAIL_DOMAIN
}

/**
 * Whether the signed-in user should get Auto as the default for new sessions.
 *
 * Resolved once per process and cached, including negative results, so repeated
 * session starts never re-hit the network.
 */
export async function shouldDefaultToAuto(): Promise<boolean> {
	if (cachedIsCastAiUser !== undefined) return cachedIsCastAiUser
	if (lookupPromise) return lookupPromise

	lookupPromise = (async () => {
		const { apiKey } = loadConfig()
		if (!apiKey) return false
		try {
			const me = await getMe(apiKey, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })
			return isCastAiEmail(me.email)
		} catch {
			// Best effort — fall back to the legacy multi-model default.
			return false
		}
	})()
		.then((result) => {
			cachedIsCastAiUser = result
			return result
		})
		.finally(() => {
			lookupPromise = undefined
		})

	return lookupPromise
}
