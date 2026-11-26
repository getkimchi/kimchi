import { ModelsError } from "@earendil-works/pi-ai/utils/models-error"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { readStoredCredential } from "@earendil-works/pi-coding-agent"
import { effectiveStoredOAuthExpiryMs, isInvalidGrantError } from "../cli-auth/oauth.js"
import { clearRefreshedCredentialStale, isCredentialKeyRejected } from "../credential-staleness.js"
import { isKimchiProvider, KIMCHI_PROVIDER_ID } from "../kimchi-provider.js"
import { syncOAuthCredentialToKimchiProviders } from "../pi-auth.js"
import {
	hasStoredOAuthRefreshConfiguration,
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
 * Transient canonical-preflight failures require a retry; falling through to
 * an active-provider-only rotation could retire the grant still held by the
 * canonical entry. They are not proof of rejection and must not mark credentials
 * stale. A definitive invalid_grant returns oauth_revoked for the surface's
 * existing sign-in handling. After a durable canonical rotation, failed fan-out
 * instead returns credential_sync_failed: submitting with an active provider's
 * retired grant could turn a local store failure into invalid_grant. The next
 * prompt retries synchronization, including creating a missing active entry.
 */
export async function prepareActivePromptKimchiCredential(
	paths: RefreshAwareCredentialPaths,
	installOAuth: (runtime: ModelRuntime, owner?: object) => void,
	activeProviderId = KIMCHI_PROVIDER_ID,
	owner?: object,
): Promise<"ready" | "oauth_revoked" | "oauth_refresh_failed" | "credential_sync_failed"> {
	if (activeProviderId !== undefined && !isKimchiProvider(activeProviderId)) return "ready"
	try {
		const storedCredential = readStoredCredential(KIMCHI_PROVIDER_ID, paths.authPath)
		if (storedCredential?.type !== "oauth") return "ready"
		// Missing issuer metadata is not proof of revocation. Preserve existing
		// request-time handling for externally-created or legacy OAuth entries.
		// Freshness follows the bearer actually sent to the gateway, so a legacy
		// ID-token bearer that expired while its stored response-derived schedule
		// is still fresh no longer skips resolution (opaque/raw credentials and
		// records without refresh metadata keep the previous outcome).
		if (
			Date.now() + KIMCHI_OAUTH_MINIMUM_VALIDITY_MS >= effectiveStoredOAuthExpiryMs(storedCredential) &&
			!hasStoredOAuthRefreshConfiguration(storedCredential)
		) {
			return "ready"
		}
		// An HTML 401 can arrive for a token that is still well outside the
		// proactive refresh window. Only the exact rejected access-token
		// fingerprint may force a rotation; provider-wide stale state or an
		// unrelated key must not retire the current grant.
		const storedTokenRejected = isCredentialKeyRejected(storedCredential.access, KIMCHI_PROVIDER_ID)
		const remainingLifetimeMs = storedCredential.expires - Date.now()
		// Inside the five-minute window the resolver already refreshes, so no
		// override is passed and refresh/error behavior stays unchanged. Outside
		// it, force exactly one refresh by requiring one millisecond more than
		// the remaining lifetime. The value must stay finite: the resolver
		// applies the explicit minimum to the refreshed token too, and Infinity
		// would fail every replacement.
		const forceRejectedTokenRefresh =
			storedTokenRejected &&
			Number.isFinite(remainingLifetimeMs) &&
			remainingLifetimeMs > KIMCHI_OAUTH_MINIMUM_VALIDITY_MS
		const getAuthOverrides = forceRejectedTokenRefresh ? { minOAuthValidityMs: remainingLifetimeMs + 1 } : undefined
		const activeCredentialBeforeCanonical =
			activeProviderId === KIMCHI_PROVIDER_ID ? undefined : readStoredCredential(activeProviderId, paths.authPath)
		// The active sub-provider may hold the very same canonical grant,
		// including the exact rejected access token. That shared entry is not an
		// independent credential: a far-future expiry copied from the canonical
		// entry must not mask the rejection that both providers share.
		const activeSharesRejectedStoredToken =
			storedTokenRejected &&
			activeCredentialBeforeCanonical?.type === "oauth" &&
			activeCredentialBeforeCanonical.access === storedCredential.access
		const resolution = await resolveRefreshAwareKimchiAuth(paths, installOAuth, owner, getAuthOverrides).catch(
			(error) => {
				// An inaccessible canonical grant must not block an independently
				// authenticated active provider that needs no refresh itself.
				if (
					activeCredentialBeforeCanonical?.type === "api_key" ||
					(activeCredentialBeforeCanonical?.type === "oauth" &&
						!activeSharesRejectedStoredToken &&
						Date.now() + KIMCHI_OAUTH_MINIMUM_VALIDITY_MS <
							effectiveStoredOAuthExpiryMs(activeCredentialBeforeCanonical))
				) {
					return undefined
				}
				throw error
			},
		)
		if (resolution === undefined) return "ready"
		const credential = readStoredCredential(KIMCHI_PROVIDER_ID, paths.authPath)
		if (credential?.type !== "oauth" || !resolution.auth?.auth.apiKey) return "ready"
		const activeCredential =
			activeProviderId === KIMCHI_PROVIDER_ID ? undefined : readStoredCredential(activeProviderId, paths.authPath)
		// A coalesced peer may have persisted the canonical replacement after
		// this call started but before its own fan-out finished. Close that gap
		// without another grant. Never replace a fresh, distinct active entry.
		// Freshness follows the selected bearer actually sent to the gateway, so
		// a legacy entry whose stored response-derived schedule outlives an
		// expired ID-token bearer counts as stale and receives the replacement.
		const staleActiveCredential =
			activeCredential?.type === "oauth" &&
			(activeCredential.access !== credential.access ||
				activeCredential.refresh !== credential.refresh ||
				activeCredential.expires !== credential.expires) &&
			Date.now() + KIMCHI_OAUTH_MINIMUM_VALIDITY_MS >= effectiveStoredOAuthExpiryMs(activeCredential)
		// Recovery must also create a child entry removed by an earlier failed
		// fan-out. An api_key child is not missing and must retain its identity.
		const synchronizationNeeded =
			resolution.refreshed ||
			staleActiveCredential ||
			(activeProviderId !== KIMCHI_PROVIDER_ID && activeCredential === undefined)
		if (Date.now() + KIMCHI_OAUTH_MINIMUM_VALIDITY_MS >= credential.expires) {
			rememberPreparedOAuthCredential(paths.authPath, credential, owner)
		}
		if (!synchronizationNeeded) return "ready"
		// Canonical rotation must not replace an independent active identity.
		// Missing or stale active entries still receive the replacement. Sharing
		// is revalidated against the post-resolution entry: the pre-resolution
		// observation above stays valid for the error fallback, but a distinct
		// independent OAuth credential installed while the canonical refresh was
		// in flight must remain protected instead of being overwritten by the
		// rotation of a token it no longer shares.
		const activeStillSharesRejectedStoredToken =
			storedTokenRejected && activeCredential?.type === "oauth" && activeCredential.access === storedCredential.access
		const protectedProviderId =
			activeProviderId !== KIMCHI_PROVIDER_ID &&
			activeCredential !== undefined &&
			!staleActiveCredential &&
			!activeStillSharesRejectedStoredToken
				? activeProviderId
				: undefined
		try {
			await syncOAuthCredentialToKimchiProviders(
				paths.authPath,
				paths.modelsPath,
				{ ...credential },
				protectedProviderId,
			)
		} catch {
			// Canonical refresh is already durable. A sub-provider left with the
			// retired grant must not consume it because a store write was transient.
			console.error({ event: "kimchi.oauth.refresh", outcome: "sync_retry" })
			try {
				await syncOAuthCredentialToKimchiProviders(
					paths.authPath,
					paths.modelsPath,
					{ ...credential },
					protectedProviderId,
				)
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
			rememberPreparedOAuthCredential(paths.authPath, credential, owner)
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
		// Do not let the original prompt refresh only its active provider. A
		// retry can safely synchronize the canonical replacement on success.
		return "oauth_refresh_failed"
	}
}
