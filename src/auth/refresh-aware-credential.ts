import { ModelsError } from "@earendil-works/pi-ai/utils/models-error"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { KIMCHI_PROVIDER_ID } from "../kimchi-provider.js"

/** Store paths needed to resolve the canonical Kimchi credential. */
export type RefreshAwareCredentialPaths = {
	authPath: string
	modelsPath: string
}

export type RefreshAwareAuth = Awaited<ReturnType<ModelRuntime["getAuth"]>>

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
): Promise<RefreshAwareAuth> {
	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: paths.authPath,
			modelsPath: paths.modelsPath,
			refreshOnCreate: false,
		})
		installOAuth(modelRuntime)
		return await modelRuntime.getAuth(KIMCHI_PROVIDER_ID)
	} catch (error) {
		// Token refresh failures are logged with typed categories at the OAuth boundary.
		// Every other failure belongs to local credential-store/runtime access.
		if (!(error instanceof ModelsError && error.code === "oauth")) {
			console.error({ event: "kimchi.oauth.refresh", outcome: "store_failed" })
		}
		throw error
	}
}
