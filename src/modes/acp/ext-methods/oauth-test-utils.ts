import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth"
import type { ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent"
import { KIMCHI_PROVIDER_ID } from "../../../kimchi-provider.js"

type ExtensionOAuthConfig = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]>["oauth"]
type ExtensionProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1]

/** Install a recording OAuth provider on a real ModelRuntime, without external network traffic. */
export function fakeOAuthDeps(
	refresh?: (credential: OAuthCredentials) => OAuthCredentials | Promise<OAuthCredentials>,
) {
	const refreshCalls: Array<Record<string, unknown>> = []
	const oauth: ExtensionOAuthConfig = {
		name: "test-oauth",
		login: () => Promise.reject(new Error("login is not part of this credential-handler contract")),
		refreshToken: (credentials) => {
			refreshCalls.push(credentials as unknown as Record<string, unknown>)
			return Promise.resolve(refresh?.(credentials) ?? credentials)
		},
		getApiKey: (credentials) => credentials.access,
	}
	return {
		refreshCalls,
		installOAuth: (runtime: ModelRuntime): void => {
			runtime.registerProvider(KIMCHI_PROVIDER_ID, { oauth } satisfies ExtensionProviderConfig)
		},
	}
}
