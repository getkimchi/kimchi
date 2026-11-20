import type { CredentialStore } from "@earendil-works/pi-ai"
import { ModelsError } from "@earendil-works/pi-ai/utils/models-error"
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent"
import { KIMCHI_PROVIDER_ID } from "../kimchi-provider.js"

/** Store paths and optional persistence override for resolving the canonical Kimchi credential. */
export type RefreshAwareCredentialPaths = {
	authPath: string
	modelsPath: string
	credentials?: CredentialStore
}

export type RefreshAwareAuth = Awaited<ReturnType<ModelRuntime["getAuth"]>>

type PiStoredCredential = NonNullable<ReturnType<typeof readStoredCredential>>
type StoredOAuthCredential = Extract<PiStoredCredential, { type: "oauth" }> & {
	/** Organization scope stamped by Kimchi login alongside upstream OAuth fields. */
	orgId?: string
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
 * No explicit cleanup is required after this promise settles: ModelRuntime
 * exposes no dispose/close API, refreshOnCreate prevents startup work, model
 * networking remains disabled by default, and getAuth releases its
 * credential-store lock before settling.
 */
export async function resolveRefreshAwareKimchiAuth(
	paths: RefreshAwareCredentialPaths,
	installOAuth: (runtime: ModelRuntime) => void,
): Promise<RefreshAwareCredentialResolution> {
	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: paths.authPath,
			modelsPath: paths.modelsPath,
			credentials: paths.credentials,
			refreshOnCreate: false,
		})
		installOAuth(modelRuntime)
		const before = readCanonicalCredential(paths.authPath)
		const auth = await modelRuntime.getAuth(KIMCHI_PROVIDER_ID)
		const after = readCanonicalCredential(paths.authPath)
		const refreshed =
			before?.type === "oauth" &&
			after?.type === "oauth" &&
			(before.access !== after.access || before.expires !== after.expires)
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
