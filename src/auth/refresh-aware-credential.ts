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
 */
export async function resolveRefreshAwareKimchiAuth(
	paths: RefreshAwareCredentialPaths,
	installOAuth: (runtime: ModelRuntime) => void,
): Promise<RefreshAwareAuth> {
	const modelRuntime = await ModelRuntime.create({
		authPath: paths.authPath,
		modelsPath: paths.modelsPath,
		refreshOnCreate: false,
	})
	installOAuth(modelRuntime)
	return modelRuntime.getAuth(KIMCHI_PROVIDER_ID)
}
