import { type CredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai"
import { ModelsError } from "@earendil-works/pi-ai/utils/models-error"
import { ModelRuntime, type ModelRuntimeAuthOverrides, readStoredCredential } from "@earendil-works/pi-coding-agent"
import { effectiveStoredOAuthExpiryMs } from "../cli-auth/oauth.js"
import { KIMCHI_PROVIDER_ID } from "../kimchi-provider.js"

/** Store paths and optional persistence override for resolving the canonical Kimchi credential. */
export type RefreshAwareCredentialPaths = {
	authPath: string
	modelsPath: string
	credentials?: CredentialStore
}

/**
 * Keep aligned with DEFAULT_OAUTH_MINIMUM_VALIDITY_MS in the pinned pi-ai
 * auth/resolve module. Upstream does not export it, so all harness call sites
 * that reason about ModelRuntime's refresh window share this local value.
 */
export const KIMCHI_OAUTH_MINIMUM_VALIDITY_MS = 5 * 60_000

export type RefreshAwareAuth = Awaited<ReturnType<ModelRuntime["getAuth"]>>

type PiStoredCredential = NonNullable<ReturnType<typeof readStoredCredential>>
type StoredOAuthCredential = Extract<PiStoredCredential, { type: "oauth" }> & {
	/** Organization scope stamped by Kimchi login alongside upstream OAuth fields. */
	orgId?: string
	/** Bearer-selection flag persisted by Kimchi login/refresh (see KimchiCredentialExtras). */
	useIdToken?: boolean
}
type StoredCredential = Exclude<PiStoredCredential, { type: "oauth" }> | StoredOAuthCredential

export type RefreshAwareCredentialResolution = {
	auth: RefreshAwareAuth
	/** Canonical credential read after getAuth releases its persist-before-release lock. */
	credential: StoredCredential | undefined
	/** True only when the persisted OAuth credential changed during this resolution. */
	refreshed: boolean
	/** Previous bearer used only for in-memory/persistent rejection bookkeeping; never logged. */
	previousAccessToken?: string
}

/** Only issuer-configured credentials can use Kimchi's refresh preflight. */
export function hasStoredOAuthRefreshConfiguration(credential: StoredCredential | undefined): boolean {
	return (
		credential?.type === "oauth" &&
		typeof credential.tokenUrl === "string" &&
		credential.tokenUrl.length > 0 &&
		typeof credential.clientId === "string" &&
		credential.clientId.length > 0
	)
}

/** Exact upstream rejection emitted when an internally forced minimum is not
 * met by the refreshed token (pi-ai auth/resolve, resolveStoredOAuth).
 *
 * pi-ai and pi-coding-agent are exactly pinned to 1.3.0 and ModelsError
 * carries only its coarse `code` — there is no stable subtype or flag that
 * distinguishes this rejection — so the exact message is the only available
 * discriminator. The active-prompt legacy tests exercise this real upstream
 * error through ModelRuntime rather than a synthetic copy, keeping the matcher
 * aligned with the pinned source. */
const FORCED_REFRESH_TOO_SOON_MESSAGE = `OAuth refresh returned a token that expires too soon for ${KIMCHI_PROVIDER_ID}`

function isForcedRefreshTooSoonError(error: unknown): boolean {
	return error instanceof ModelsError && error.code === "oauth" && error.message === FORCED_REFRESH_TOO_SOON_MESSAGE
}

/**
 * Legacy recovery: credentials persisted before the shared bearer-expiry rule
 * can carry a stored response-derived schedule that outlives the selected
 * ID-token bearer actually sent to the gateway. When the stored schedule is
 * outside upstream's ordinary five-minute renewal window while the effective
 * selected-bearer expiry is inside it, an ordinary getAuth treats the
 * credential as fresh and never refreshes. Returning a one-shot minimum equal
 * to the remaining stored schedule makes upstream's expiresSoon predicate
 * refresh the legacy credential under its normal lock, coalescing, and
 * persist-before-release discipline. Every other credential shape — raw
 * access tokens, opaque bearers, already-fresh schedules, or records without
 * issuer refresh metadata — returns undefined so resolution stays ordinary.
 *
 * The minimum is fixed before the call starts, and upstream reuses that same
 * fixed minimum for its under-lock `needsRefresh` re-check (pi-ai
 * resolveStoredOAuth passes its expiresSoon predicate into
 * refreshStoredOAuthCredential). A peer that persists a corrected credential
 * while this resolution is in flight can therefore still fail that under-lock
 * check and cause one bounded redundant grant — including when the peer's
 * replacement arrives inside the ordinary five-minute window. No public
 * dynamic predicate exists and ModelRuntime accepts only a fixed minimum, so
 * re-reading the store would merely move the race; the store lock and
 * coalescing bound the redundancy to a single grant per forced resolution.
 */
function forcedLegacyRefreshMinimumMs(credential: StoredCredential | undefined): number | undefined {
	if (credential?.type !== "oauth" || !hasStoredOAuthRefreshConfiguration(credential)) return undefined
	const nowMs = Date.now()
	if (nowMs + KIMCHI_OAUTH_MINIMUM_VALIDITY_MS >= credential.expires) return undefined
	if (nowMs + KIMCHI_OAUTH_MINIMUM_VALIDITY_MS < effectiveStoredOAuthExpiryMs(credential)) return undefined
	return Math.max(1, credential.expires - nowMs + 1)
}

function readCanonicalCredential(authPath: string): StoredCredential | undefined {
	try {
		return readStoredCredential(KIMCHI_PROVIDER_ID, authPath)
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${KIMCHI_PROVIDER_ID}`, { cause: error })
	}
}

/**
 * Resolve the canonical Kimchi credential through the same lazy-refresh path
 * used for model requests. The caller supplies the production Kimchi OAuth
 * registration (or a test equivalent); ModelRuntime owns the five-minute
 * refresh window, operation coalescing, store lock, and persist-before-release
 * discipline.
 *
 * Provider registration queues asynchronous availability/catalog refreshes.
 * This temporary runtime needs the provider configuration in models.json, but
 * not the persistent dynamic model catalog. Keep that unrelated cache in
 * memory so callers do not have to wait for background model-store locks after
 * credential resolution settles. Authentication still uses the supplied
 * credential store or the file-backed auth path.
 */
export async function resolveRefreshAwareKimchiAuth(
	paths: RefreshAwareCredentialPaths,
	installOAuth: (runtime: ModelRuntime, owner?: object) => void,
	owner?: object,
	getAuthOverrides?: ModelRuntimeAuthOverrides,
): Promise<RefreshAwareCredentialResolution> {
	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: paths.authPath,
			modelsPath: paths.modelsPath,
			modelsStore: new InMemoryModelsStore(),
			credentials: paths.credentials,
			refreshOnCreate: false,
		})
		installOAuth(modelRuntime, owner)
		const before = readCanonicalCredential(paths.authPath)
		// A caller-forced minimum (exact rejected access token) wins; otherwise
		// the legacy re-derivation above supplies a one-shot minimum when the
		// stored schedule outlives the selected bearer. Either way a forced
		// minimum only applies when it is non-undefined.
		const forcedMinimumMs = getAuthOverrides?.minOAuthValidityMs ?? forcedLegacyRefreshMinimumMs(before)
		let auth: RefreshAwareAuth
		try {
			if (getAuthOverrides) {
				auth = await modelRuntime.getAuth(KIMCHI_PROVIDER_ID, getAuthOverrides)
			} else if (forcedMinimumMs === undefined) {
				auth = await modelRuntime.getAuth(KIMCHI_PROVIDER_ID)
			} else {
				auth = await modelRuntime.getAuth(KIMCHI_PROVIDER_ID, { minOAuthValidityMs: forcedMinimumMs })
			}
		} catch (error) {
			// Upstream applies the forced minimum after the refresh too and
			// rejects a valid shorter replacement. That refresh is already
			// durable, so re-resolve once without the temporary minimum. A
			// replacement still inside the ordinary five-minute window makes that
			// ordinary re-resolution issue one additional grant before accepting
			// it; one outside the window is accepted with no second grant. Either
			// way, the short-lived-credential handoff is registered only after this
			// resolver returns, so it cannot suppress either grant. This applies
			// to caller-forced rejection refreshes as well: the rejected grant is
			// retired either way and the durable replacement should be accepted.
			// No other error — invalid grants, transient failures, store errors —
			// is caught or remapped here.
			if (forcedMinimumMs === undefined || !isForcedRefreshTooSoonError(error)) throw error
			auth = await modelRuntime.getAuth(KIMCHI_PROVIDER_ID)
		}
		const after = readCanonicalCredential(paths.authPath)
		const refreshed =
			before?.type === "oauth" &&
			after?.type === "oauth" &&
			(before.access !== after.access || before.refresh !== after.refresh || before.expires !== after.expires)
		return {
			auth,
			credential: after,
			refreshed,
			previousAccessToken: refreshed && before?.type === "oauth" ? before.access : undefined,
		}
	} catch (error) {
		// Token refresh failures are logged with typed categories at the OAuth boundary.
		// Every other failure belongs to local credential-store/runtime access.
		if (!(error instanceof ModelsError && error.code === "oauth")) {
			console.error({ event: "kimchi.oauth.refresh", outcome: "store_failed" })
		}
		throw error
	}
}
