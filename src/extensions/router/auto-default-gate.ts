/**
 * Gates Auto to @cast.ai accounts (internal dogfooding) and the
 * `--enable-experimental-features` launch flag.
 *
 * `getMe` is awaited at startup (<=3s); on timeout or failure the gate reports
 * false. For entitled accounts Auto becomes the fresh-session default (unless
 * the user explicitly selected another model); for everyone else the model
 * stays in the catalogue for session restoration but is hidden from discovery
 * surfaces (see model-discovery.ts) unless experimental features are enabled.
 */

import { getMe } from "../../api/me.js"
import { loadConfig } from "../../config.js"

const CAST_AI_EMAIL_DOMAIN = "cast.ai"

/** Budget for the identity lookup; startup must not hang on a slow API. */
const LOOKUP_TIMEOUT_MS = 3000

/** Resolved identity: whether the account is entitled, and who it is. */
export interface AutoEntitlement {
	entitled: boolean
	/** Account id from /v1/me; empty when the lookup failed. */
	userId: string
}

const NOT_ENTITLED: AutoEntitlement = { entitled: false, userId: "" }

let cachedEntitlement: AutoEntitlement | undefined
let lookupPromise: Promise<AutoEntitlement> | undefined

/** @internal — exposed for testing only */
export function _resetAutoDefaultGateCache(): void {
	cachedEntitlement = undefined
	lookupPromise = undefined
}

/** @internal — exposed for testing only: seed the cached entitlement without a network lookup. */
export function _setAutoDefaultGateCache(value: boolean | undefined, userId = "test-user"): void {
	cachedEntitlement = value === undefined ? undefined : { entitled: value, userId }
}

/**
 * Sync read of the cached entitlement, for call sites that cannot await
 * (model-picker discovery filter, role lists). False until the startup lookup
 * resolves — session_start awaits `shouldDefaultToAuto()` before the UI can
 * open those surfaces, and cli.ts kicks the lookup off pre-main.
 */
export function isAutoEntitledUser(): boolean {
	return cachedEntitlement?.entitled ?? false
}

/**
 * Sync read of the resolved identity, for the rollout marker (which is keyed by
 * account id so a shared machine rolls in each user separately). Empty userId
 * until the startup lookup resolves.
 */
export function getAutoEntitlement(): AutoEntitlement {
	return cachedEntitlement ?? NOT_ENTITLED
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
export async function resolveAutoEntitlement(): Promise<AutoEntitlement> {
	if (cachedEntitlement !== undefined) return cachedEntitlement
	if (lookupPromise) return lookupPromise

	lookupPromise = (async (): Promise<AutoEntitlement> => {
		const { apiKey } = loadConfig()
		if (!apiKey) return NOT_ENTITLED
		try {
			const me = await getMe(apiKey, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })
			return { entitled: isCastAiEmail(me.email), userId: me.id ?? "" }
		} catch {
			// Best effort — fall back to the legacy multi-model default.
			return NOT_ENTITLED
		}
	})()
		.then((result) => {
			cachedEntitlement = result
			return result
		})
		.finally(() => {
			lookupPromise = undefined
		})

	return lookupPromise
}

export async function shouldDefaultToAuto(): Promise<boolean> {
	return (await resolveAutoEntitlement()).entitled
}
