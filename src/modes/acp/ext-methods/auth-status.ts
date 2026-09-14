// ACP extension method handler for reporting harness auth state.
//
// Wire name: `_kimchi.dev/auth_status` — the vendor-namespaced method for
// Studio's getAuthStatus (in-app ACP auth epic), advertised via
// _meta["kimchi.dev"].auth_status. Sessionless on purpose: identity is
// global, not session-scoped, so the request carries no sessionId.

import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../../../config.js"
import { isCredentialStale } from "../../../credential-staleness.js"
import { KIMCHI_PROVIDER_ID } from "../../../kimchi-provider.js"

export type AuthStatusResponse = {
	authenticated: boolean
}

/**
 * Credential-store locations the auth check reads from. Both halves of the
 * shared store are consulted because either can hold the live credentials:
 * `authenticate()`/API-key login persist to config.json's apiKey, while the
 * subscription OAuth login persists only to auth.json.
 */
export type AuthStatusPaths = {
	/** Pi auth storage (agentDir/auth.json); checked for a kimchi-dev credential. */
	authPath: string
	/** Pi models registry (agentDir/models.json) — required to construct ModelRuntime. */
	modelsPath: string
	/** Harness config path override; defaults to the shared KIMCHI_CONFIG_PATH. */
	configPath?: string
}

/**
 * Auth status handler for `_kimchi.dev/auth_status`.
 *
 * Reports whether the shared credential store currently holds Kimchi
 * credentials, so clients (e.g. Studio's onboarding gate) can ask on the
 * live ACP connection without attempting a session.
 *
 * Both halves of the credential store are re-read per call — config.json's
 * apiKey, then a fresh credential listing from auth.json — so state written
 * by authenticate()/unstable_logout() on this connection (which write/clear
 * both halves), or by other Kimchi surfaces sharing the store (terminal
 * `kimchi login`, the VS Code extension), is reflected immediately on the
 * next call.
 *
 * The check is `listCredentials()` rather than `getProviderAuthStatus()` on
 * purpose: ModelRuntime only populates its stored-providers snapshot during
 * an availability refresh (skipped here via refreshOnCreate: false), so the
 * status getter would be stale for freshly written or externally changed
 * credentials. Only the base kimchi-dev credential is authoritative —
 * unstable_logout() removes exactly it, so it defines "logged in".
 */
export async function handleAuthStatus(paths: AuthStatusPaths): Promise<AuthStatusResponse> {
	const apiKey = loadConfig(paths.configPath ? { configPath: paths.configPath } : undefined).apiKey
	// A 401 mark (key-level or provider-level — credential-staleness.ts)
	// means logged-out, even though the key exists on disk.
	if (isCredentialStale(apiKey, KIMCHI_PROVIDER_ID)) {
		return { authenticated: false }
	}
	if (apiKey) {
		return { authenticated: true }
	}
	const modelRuntime = await ModelRuntime.create({
		authPath: paths.authPath,
		modelsPath: paths.modelsPath,
		refreshOnCreate: false,
	})
	const credentials = await modelRuntime.listCredentials()
	return { authenticated: credentials.some((credential) => credential.providerId === KIMCHI_PROVIDER_ID) }
}
