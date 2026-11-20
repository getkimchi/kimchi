import { ModelsError } from "@earendil-works/pi-ai/utils/models-error"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { readStoredCredential } from "@earendil-works/pi-coding-agent"
import { isInvalidGrantError } from "../cli-auth/oauth.js"
import { clearRefreshedCredentialStale } from "../credential-staleness.js"
import { isKimchiProvider, KIMCHI_PROVIDER_ID } from "../kimchi-provider.js"
import { syncOAuthCredentialToKimchiProviders } from "../pi-auth.js"
import {
	KIMCHI_OAUTH_MINIMUM_VALIDITY_MS,
	type RefreshAwareCredentialPaths,
	resolveRefreshAwareKimchiAuth,
} from "./refresh-aware-credential.js"
import { rememberPreparedOAuthCredential } from "./short-lived-credential-handoff.js"

/**
 * Refresh canonical Kimchi OAuth state before an active TUI/ACP user prompt.
 *
 * ModelRuntime keeps ownership of the five-minute window, locking, coalescing,
 * and persist-before-use. The fan-out is necessary because prompt requests
 * resolve their concrete kimchi-dev/* provider while auth_status and other
 * shared-store readers use the canonical kimchi-dev entry. Refreshing only
 * the concrete entry leaves the other entries presenting the retired grant.
 *
 * Transient refresh and store failures before durable rotation deliberately
 * fall through to the original prompt's existing auth path; they are not proof
 * of rejection and must not mark credentials stale. A definitive invalid_grant
 * returns oauth_revoked for the surface's existing sign-in handling. After a
 * durable canonical rotation, failed fan-out instead returns credential_sync_failed:
 * submitting with an active provider's retired grant could turn a local store
 * failure into invalid_grant. The next prompt retries only synchronization.
 */
export async function prepareActivePromptKimchiCredential(
	paths: RefreshAwareCredentialPaths,
	installOAuth: (runtime: ModelRuntime, owner?: object) => void,
	activeProviderId = KIMCHI_PROVIDER_ID,
	owner?: object,
): Promise<"ready" | "oauth_revoked" | "credential_sync_failed"> {
	if (activeProviderId !== undefined && !isKimchiProvider(activeProviderId)) return "ready"
	try {
		if (readStoredCredential(KIMCHI_PROVIDER_ID, paths.authPath)?.type !== "oauth") return "ready"
		const resolution = await resolveRefreshAwareKimchiAuth(paths, installOAuth, owner)
		const credential = readStoredCredential(KIMCHI_PROVIDER_ID, paths.authPath)
		if (credential?.type !== "oauth" || !resolution.auth?.auth.apiKey) return "ready"
		const activeCredential =
			activeProviderId === KIMCHI_PROVIDER_ID ? undefined : readStoredCredential(activeProviderId, paths.authPath)
		// A coalesced peer may have persisted the canonical replacement after
		// this call started but before its own fan-out finished. Close that gap
		// without another grant. Never replace a fresh, distinct active entry.
		const staleActiveCredential =
			activeCredential?.type === "oauth" &&
			(activeCredential.access !== credential.access ||
				activeCredential.refresh !== credential.refresh ||
				activeCredential.expires !== credential.expires) &&
			Date.now() + KIMCHI_OAUTH_MINIMUM_VALIDITY_MS >= activeCredential.expires
		if (Date.now() + KIMCHI_OAUTH_MINIMUM_VALIDITY_MS >= credential.expires) {
			rememberPreparedOAuthCredential(
				paths.authPath,
				credential,
				{
					fanoutPending: resolution.refreshed || staleActiveCredential,
				},
				owner,
			)
		}
		if (!resolution.refreshed && !staleActiveCredential) return "ready"
		try {
			await syncOAuthCredentialToKimchiProviders(paths.authPath, paths.modelsPath, { ...credential })
		} catch {
			// Canonical refresh is already durable. A sub-provider left with the
			// retired grant must not consume it because a store write was transient.
			console.error({ event: "kimchi.oauth.refresh", outcome: "sync_retry" })
			try {
				await syncOAuthCredentialToKimchiProviders(paths.authPath, paths.modelsPath, { ...credential })
			} catch (error) {
				const errorType = error instanceof Error ? error.name : typeof error
				console.error({ event: "kimchi.oauth.refresh", outcome: "sync_failed", errorType })
				return "credential_sync_failed"
			}
		}
		if (resolution.refreshed) {
			clearRefreshedCredentialStale(resolution.previousAccessToken, resolution.auth.auth.apiKey, KIMCHI_PROVIDER_ID)
		}
		if (Date.now() + KIMCHI_OAUTH_MINIMUM_VALIDITY_MS >= credential.expires) {
			rememberPreparedOAuthCredential(paths.authPath, credential, { fanoutPending: false }, owner)
		}
		return "ready"
	} catch (error) {
		const errorType = error instanceof Error ? error.name : typeof error
		if (error instanceof ModelsError && error.code === "oauth" && isInvalidGrantError(error.cause)) {
			console.error({ event: "kimchi.oauth.refresh", outcome: "grant_rejected", errorType })
			return "oauth_revoked"
		}
		// Error text and stacks can contain provider-supplied credential material.
		// Log only the category so unexpected failures remain diagnosable safely.
		console.error({ event: "kimchi.oauth.refresh", outcome: "preflight_failed", errorType })
		return "ready"
	}
}
