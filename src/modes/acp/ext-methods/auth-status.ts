// ACP extension method handler for reporting harness auth state.
//
// Wire name: `_kimchi.dev/auth_status` — the vendor-namespaced method for
// Studio's getAuthStatus (in-app ACP auth epic), advertised via
// _meta["kimchi.dev"].auth_status. Sessionless on purpose: identity is
// global, not session-scoped, so the request carries no sessionId.

import { ModelsError } from "@earendil-works/pi-ai/utils/models-error"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import {
	type RefreshAwareCredentialResolution,
	resolveRefreshAwareKimchiAuth,
} from "../../../auth/refresh-aware-credential.js"
import { isInvalidGrantError } from "../../../cli-auth/oauth.js"
import { loadConfig } from "../../../config.js"
import { clearRefreshedCredentialStale, isCredentialStale } from "../../../credential-staleness.js"
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
 * persisted before the response. This can perform token-endpoint network I/O,
 * bounded by the Kimchi OAuth token-request timeout. Only the base kimchi-dev
 * credential is authoritative — unstable_logout() removes exactly it, so it defines
 * "logged in".
 */
export async function handleAuthStatus(
	paths: AuthStatusPaths,
	deps: AuthStatusDeps = {
		installOAuth: (runtime) => installKimchiOAuth(runtime, paths.authPath),
	},
): Promise<AuthStatusResponse> {
	const apiKey = loadConfig(paths.configPath ? { configPath: paths.configPath } : undefined).apiKey
	if (apiKey) {
		// API-key precedence also preserves its observed-rejection behavior.
		return { authenticated: !isCredentialStale(apiKey, KIMCHI_PROVIDER_ID) }
	}
	let resolution: RefreshAwareCredentialResolution
	try {
		// An access-token 401 must not block refresh: the grant itself determines
		// whether this credential can recover. An unchanged stale OAuth credential
		// is still rejected after resolution below.
		resolution = await resolveRefreshAwareKimchiAuth(paths, deps.installOAuth)
	} catch (error) {
		if (error instanceof ModelsError && error.code === "oauth" && isInvalidGrantError(error.cause)) {
			return { authenticated: false }
		}
		// Transient refresh and store failures reject as unknown; an older 401
		// mark cannot turn this new failed operation into a definitive sign-out.
		throw error
	}
	const { auth } = resolution
	if (!auth) return { authenticated: false }
	if (resolution.refreshed) {
		if (!auth.auth.apiKey) return { authenticated: false }
		// The persisted refresh is an authenticated success. Retire only the
		// provider and rotated OAuth values, never unrelated API-key marks.
		clearRefreshedCredentialStale(resolution.previousAccessToken, auth.auth.apiKey, KIMCHI_PROVIDER_ID)
		return { authenticated: true }
	}
	return { authenticated: !isCredentialStale(auth.auth.apiKey, KIMCHI_PROVIDER_ID) }
}
