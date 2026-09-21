/**
 * Gates Auto to @cast.ai accounts (internal dogfooding) and the
 * `--enable-experimental-features` launch flag.
 *
 * `getMe` is awaited at startup (<=3s); on timeout or failure the gate reports
 * false, leaving the install on whatever default it already had.
 *
 * Entitlement only says the account is in the audience. Whether Auto is
 * actually installed as the saved default is decided once per install by the
 * `autoDefaultApplied` marker in settings.json (see router/index.ts), so a
 * model chosen afterwards is never overwritten. Entitlement also makes Auto
 * visible: for everyone else it stays in the catalogue for session restoration
 * but is hidden from discovery surfaces (see model-discovery.ts) unless
 * experimental features are enabled.
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

/** @internal — exposed for testing only: seed the cached entitlement without a network lookup. */
export function _setAutoDefaultGateCache(value: boolean | undefined): void {
	cachedIsCastAiUser = value
}

/**
 * Sync read of the cached entitlement, for call sites that cannot await
 * (model-picker discovery filter, role lists).
 *
 * Reports false until the lookup resolves, deliberately collapsing "not
 * entitled" and "not known yet": these call sites render, so the alternative is
 * blocking them on the network. `cli.ts` starts the lookup pre-main to shrink
 * that window, but it is not closed — `session_start` only awaits
 * `shouldDefaultToAuto()` when it is about to install the default, so a resumed
 * session can reach a picker while the lookup is still in flight and briefly
 * omit Auto. It appears on reopen, once the cache is warm.
 */
export function isAutoEntitledUser(): boolean {
	return cachedIsCastAiUser ?? false
}

/** Start the identity lookup without blocking the caller; result is cached for later reads. */
export function warmAutoDefaultGate(): void {
	void shouldDefaultToAuto()
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

	lookupPromise = (async (): Promise<boolean> => {
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
