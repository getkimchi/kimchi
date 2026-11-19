import { ModelsError } from "@earendil-works/pi-ai/utils/models-error"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { readStoredCredential } from "@earendil-works/pi-coding-agent"
import { isInvalidGrantError } from "../cli-auth/oauth.js"
import { clearRefreshedCredentialStale } from "../credential-staleness.js"
import { KIMCHI_PROVIDER_ID } from "../kimchi-provider.js"
import { syncOAuthCredentialToKimchiProviders } from "../pi-auth.js"
import { type RefreshAwareCredentialPaths, resolveRefreshAwareKimchiAuth } from "./refresh-aware-credential.js"

/**
 * Refresh canonical Kimchi OAuth state before an active TUI/ACP user prompt.
 *
 * ModelRuntime keeps ownership of the five-minute window, locking, coalescing,
 * and persist-before-use. The fan-out is necessary because prompt requests
 * resolve their concrete kimchi-dev/* provider while auth_status and other
 * shared-store readers use the canonical kimchi-dev entry. Refreshing only
 * the concrete entry leaves the other entries presenting the retired grant.
 *
 * Transient refresh and store failures deliberately fall through to the
 * original prompt's existing auth path; they are not proof of rejection and
 * must not mark credentials stale. Definitive invalid_grant keeps the normal
 * thrown-error sign-in behavior. API keys never enter this path.
 */
const ACTIVE_CREDENTIAL_SYNC_WINDOW_MS = 5 * 60_000

export async function prepareActivePromptKimchiCredential(
	paths: RefreshAwareCredentialPaths,
	installOAuth: (runtime: ModelRuntime) => void,
	activeProviderId = KIMCHI_PROVIDER_ID,
): Promise<void> {
	try {
		if (readStoredCredential(KIMCHI_PROVIDER_ID, paths.authPath)?.type !== "oauth") return
		const resolution = await resolveRefreshAwareKimchiAuth(paths, installOAuth)
		const credential = readStoredCredential(KIMCHI_PROVIDER_ID, paths.authPath)
		if (credential?.type !== "oauth" || !resolution.auth?.auth.apiKey) return
		const activeCredential =
			activeProviderId === KIMCHI_PROVIDER_ID ? undefined : readStoredCredential(activeProviderId, paths.authPath)
		// A coalesced peer may have persisted the canonical replacement after
		// this call started but before its own fan-out finished. Close that gap
		// without another grant. Never replace a fresh, distinct active entry.
		const staleActiveCredential =
			activeCredential?.type === "oauth" &&
			(activeCredential.access !== credential.access || activeCredential.refresh !== credential.refresh) &&
			Date.now() + ACTIVE_CREDENTIAL_SYNC_WINDOW_MS >= activeCredential.expires
		if (!resolution.refreshed && !staleActiveCredential) return
		try {
			await syncOAuthCredentialToKimchiProviders(paths.authPath, paths.modelsPath, { ...credential })
		} catch {
			// Canonical refresh is already durable. A sub-provider left with the
			// retired grant must not consume it because a store write was transient.
			console.error({ event: "kimchi.oauth.refresh", outcome: "sync_retry" })
			await syncOAuthCredentialToKimchiProviders(paths.authPath, paths.modelsPath, { ...credential })
		}
		if (resolution.refreshed) {
			clearRefreshedCredentialStale(resolution.previousAccessToken, resolution.auth.auth.apiKey, KIMCHI_PROVIDER_ID)
		}
	} catch (error) {
		if (error instanceof ModelsError && error.code === "oauth" && isInvalidGrantError(error.cause)) throw error
	}
}
