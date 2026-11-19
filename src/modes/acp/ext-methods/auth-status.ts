// ACP extension method handler for reporting harness auth state.
//
// Wire name: `_kimchi.dev/auth_status` — the vendor-namespaced method for
// Studio's getAuthStatus (in-app ACP auth epic), advertised via
// _meta["kimchi.dev"].auth_status. Sessionless on purpose: identity is
// global, not session-scoped, so the request carries no sessionId.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { type RefreshAwareAuth, resolveRefreshAwareKimchiAuth } from "../../../auth/refresh-aware-credential.js"
import { loadConfig } from "../../../config.js"
import { clearCredentialStale, isCredentialStale } from "../../../credential-staleness.js"
import { installKimchiOAuth } from "../../../extensions/login/flow.js"
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

/** Kimchi OAuth registration for the standalone runtime; injectable for local fake-provider tests. */
export type AuthStatusDeps = {
	installOAuth: (runtime: ModelRuntime) => void
}

/**
 * Auth status handler for `_kimchi.dev/auth_status`.
 *
 * Reports whether the shared credential store currently holds Kimchi
 * credentials, so clients (e.g. Studio's onboarding gate) can ask on the
 * live ACP connection without attempting a session.
 *
 * Both halves of the credential store are re-read per call — config.json's
 * apiKey, then the canonical auth.json credential through ModelRuntime — so
 * state written by authenticate()/unstable_logout() on this connection or by
 * other Kimchi surfaces is reflected immediately on the next call. OAuth
 * credentials inside the five-minute validity window are refreshed and
 * persisted before the response. Only the base kimchi-dev credential is
 * authoritative — unstable_logout() removes exactly it, so it defines
 * "logged in".
 */
export async function handleAuthStatus(
	paths: AuthStatusPaths,
	deps: AuthStatusDeps = { installOAuth: installKimchiOAuth },
): Promise<AuthStatusResponse> {
	const apiKey = loadConfig(paths.configPath ? { configPath: paths.configPath } : undefined).apiKey
	// A 401 mark (key-level or provider-level — credential-staleness.ts)
	// means logged-out, even though the key exists on disk.
	if (isCredentialStale(apiKey, KIMCHI_PROVIDER_ID)) {
		return { authenticated: false }
	}
	if (apiKey) {
		return { authenticated: true }
	}
	let auth: RefreshAwareAuth
	try {
		auth = await resolveRefreshAwareKimchiAuth(paths, deps.installOAuth)
	} catch (error) {
		// Kimchi's OAuth registration marks invalid_grant before rethrowing.
		// Other refresh and store failures reject the read so clients classify
		// the result as unknown rather than signing the user out.
		if (isCredentialStale(undefined, KIMCHI_PROVIDER_ID)) return { authenticated: false }
		throw error
	}
	if (!auth || isCredentialStale(auth.auth.apiKey, KIMCHI_PROVIDER_ID)) {
		return { authenticated: false }
	}
	clearCredentialStale(KIMCHI_PROVIDER_ID)
	return { authenticated: true }
}
