// ACP extension method handler for exporting the current SSO credential.
//
// Wire name: `_kimchi.dev/sso_credential` — the vendor-namespaced sessionless
// method for Studio's post-SSO users-API calls (LLM-4134, ticket #643),
// advertised via _meta["kimchi.dev"].sso_credential.
//
// Wire-contract verification (recorded on ticket #643): the Cast AI users API
// accepts the harness's OAuth bearer as `Authorization: Bearer` (200 on
// /v1/me and /v1/organizations) and rejects `X-API-Key` (401 nginx), so the
// raw credential is both safe and necessary to hand to the client — the
// proxied-lookup alternative is not needed.
//
// The returned credential is exactly the bearer the harness itself sends for
// its own users-API call (`listUserOrganizations` sends
// `authorization: Bearer ${credential.access}`): the stored `access` token,
// which is the ID token under the default useIdToken configuration. Reading
// auth.json directly would 401 at expiry, so the handler resolves the
// credential through the harness's own lazy-refresh discipline instead:
// ModelRuntime.getAuth refreshes tokens with <5 min validity under the
// credential-store lock and persists before release — the same path every
// harness request takes, with no refresh logic of its own. The canonical
// `kimchi-dev` entry is read (the fan-out writes identical copies under
// `kimchi-dev/*`, but the base entry is authoritative — unstable_logout()
// removes exactly it).

import { RequestError } from "@agentclientprotocol/sdk"
import { ModelsError } from "@earendil-works/pi-ai/utils/models-error"
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../../../config.js"
import { isCredentialStale } from "../../../credential-staleness.js"
import { KIMCHI_PROVIDER_ID } from "../../../kimchi-provider.js"

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Application-level JSON-RPC code, mirroring the SSO flow errors
 * (`ssoError` in ./sso.ts): clients MUST branch on `data.code`, never on the
 * numeric code or the message. */
const SSO_CREDENTIAL_JSON_RPC_ERROR_CODE = -32000

/** Machine codes carried in `data.code` of the JSON-RPC error object. */
export type SsoCredentialErrorCode = "SSO_NOT_AUTHENTICATED" | "SSO_REFRESH_FAILED" | "SSO_STORE_UNAVAILABLE"

export function ssoCredentialError(
	code: SsoCredentialErrorCode,
	message: string,
	extra?: Record<string, unknown>,
): RequestError {
	// `message` rides the standard top-level JSON-RPC error field; duplicated
	// into `data` like the SSO flow errors so clients may render either.
	return new RequestError(SSO_CREDENTIAL_JSON_RPC_ERROR_CODE, message, { code, message, ...extra })
}

// ---------------------------------------------------------------------------
// Wire shapes
// ----------------------------------------------------------------//

// Type alias, not interface: aliases carry implicit index signatures, so the
// handler return is directly assignable to the extMethod contract's
// `Record<string, unknown>` without casts or spreads.
export type SsoCredentialResponse = {
	/** The current valid OAuth bearer — send it as `Authorization: Bearer`.
	 * The same token the harness itself sends for its users-API calls. */
	credential: string
	/** Organization the credential is scoped to (SSO credentials are always
	 * org-scoped; the org survives token refreshes). */
	orgId: string
	orgName?: string
	/** Region the credential authenticates against ("us" | "eu") — resolves
	 * the users-API base URL client-side. */
	region?: string
	/** RFC 3339 UTC instant after which the credential must be re-fetched. */
	expiry: string
}

/** Credential-store locations the export reads from — same halves as
 * `auth_status` (./auth-status.ts). */
export type SsoCredentialPaths = {
	/** Pi auth storage (agentDir/auth.json). */
	authPath: string
	/** Pi models registry (agentDir/models.json) — required to construct ModelRuntime. */
	modelsPath: string
	/** Harness config path override; defaults to the shared KIMCHI_CONFIG_PATH. */
	configPath?: string
}

/** Injectable provider-registration step. Production passes
 * `installKimchiOAuth` (extensions/login/flow.ts) so the runtime's kimchi-dev
 * provider carries the real OAuth refresh handler; tests inject fakes. */
export type SsoCredentialDeps = {
	installOAuth: (runtime: ModelRuntime) => void
}

/** SSO entry extras carried alongside the standard OAuth credential fields
 * (see `KimchiCredentialExtras` in cli-auth/oauth.ts — untyped in pi-ai's
 * Credential, same access pattern as the login extension). */
type KimchiSsoCredentialExtras = {
	orgId?: unknown
	orgName?: unknown
	region?: unknown
}

/** Raw stored-credential shape (pi-coding-agent keeps `Credential`
 * internal — derive it from the reader instead of importing). */
type StoredCredential = NonNullable<ReturnType<typeof readStoredCredential>>

function notAuthenticated(message: string): RequestError {
	return ssoCredentialError("SSO_NOT_AUTHENTICATED", message)
}

/** Store-level failure (unreadable config.json, missing models.json, broken
 * auth.json, runtime construction): never a raw error — the header contract
 * says clients branch on `data.code`, and this is recoverable differently
 * from both "not SSO-authenticated" (re-login) and "refresh failed"
 * (transient): the store itself is the problem. */
function storeUnavailable(context: string, error: unknown): RequestError {
	const detail = error instanceof Error ? error.message : String(error)
	return ssoCredentialError("SSO_STORE_UNAVAILABLE", `${context}: ${detail}`, { detail })
}

/**
 * Handler for `_kimchi.dev/sso_credential`.
 *
 * Returns the current valid org-scoped credential for the canonical
 * `kimchi-dev` entry, refreshed with the harness's lazy-refresh discipline.
 * Key-based sessions are out of scope for this method — they fail with
 * `SSO_NOT_AUTHENTICATED`, not with a credential.
 *
 * Re-reads the shared store per call (config.json apiKey, then auth.json via
 * a throwaway ModelRuntime), so logins/logouts from any Kimchi surface are
 * reflected on the next call — same discipline as `auth_status`.
 */
export async function handleSsoCredential(
	deps: SsoCredentialDeps,
	paths: SsoCredentialPaths,
): Promise<SsoCredentialResponse> {
	// Setup phase — every failure maps to a typed code; none may escape raw.
	// A live config.json apiKey means a key-based login: the startup sync
	// mirrors it into auth.json as type "api_key" entries, so there is no
	// OAuth credential to export. (After an SSO login the harness clears the
	// config key — see settleSsoCredential — so the two shapes don't coexist.)
	let apiKey: string | undefined
	try {
		apiKey = loadConfig(paths.configPath ? { configPath: paths.configPath } : undefined).apiKey
	} catch (error) {
		throw storeUnavailable("Reading the Kimchi config failed", error)
	}
	if (apiKey && !isCredentialStale(apiKey, KIMCHI_PROVIDER_ID)) {
		throw notAuthenticated("The current Kimchi session is API-key based; no SSO credential is available")
	}

	let modelRuntime: ModelRuntime
	try {
		modelRuntime = await ModelRuntime.create({
			authPath: paths.authPath,
			modelsPath: paths.modelsPath,
			refreshOnCreate: false,
		})
	} catch (error) {
		throw storeUnavailable("Reading the Kimchi credential store failed", error)
	}
	deps.installOAuth(modelRuntime)

	let auth: Awaited<ReturnType<ModelRuntime["getAuth"]>>
	try {
		// Default minOAuthValidityMs (five minutes): tokens with less validity
		// remaining are refreshed under the credential-store lock and persisted
		// before release — the exact discipline every harness request uses.
		auth = await modelRuntime.getAuth(KIMCHI_PROVIDER_ID)
	} catch (error) {
		// Distinguish the failure classes: refreshStoredOAuthCredential wraps
		// refresh failures in a ModelsError with code "oauth" (invalid_grant =
		// dead refresh token → re-login; anything else transient). Store
		// read/modify failures arrive as ModelsError("auth") and non-ModelsError
		// errors — mapping those to SSO_REFRESH_FAILED would send clients into a
		// refresh-retry loop against a store that can no longer be read.
		if (error instanceof ModelsError && error.code === "oauth") {
			const detail = error.cause instanceof Error ? error.cause.message : error.message
			throw ssoCredentialError("SSO_REFRESH_FAILED", `Refreshing the Kimchi SSO credential failed: ${detail}`, {
				detail,
			})
		}
		throw storeUnavailable("Resolving the Kimchi credential failed", error)
	}
	if (auth?.source !== "OAuth") {
		throw notAuthenticated("No SSO credential is stored for Kimchi")
	}

	// Single snapshot: every returned field comes from ONE read of the store,
	// taken AFTER any triggered refresh has persisted. Deriving `credential`
	// from the getAuth result and the extras from a later read could pair a
	// pre-refresh bearer with a post-refresh expiry when another Kimchi
	// surface (TUI, second ACP client) refreshes or logs out in between —
	// the client would then cache a dead token until a bogus deadline.
	const stored = readStoredCredential(KIMCHI_PROVIDER_ID, paths.authPath)
	if (
		stored?.type !== "oauth" ||
		typeof stored.access !== "string" ||
		stored.access.length === 0 ||
		!Number.isFinite(stored.expires)
	) {
		throw notAuthenticated("No SSO credential is stored for Kimchi")
	}
	const extras = stored as StoredCredential & KimchiSsoCredentialExtras
	if (typeof extras.orgId !== "string" || extras.orgId.length === 0) {
		throw notAuthenticated("The stored Kimchi credential is not organization-scoped (not an SSO login)")
	}

	return {
		// stored.access is the bearer the harness's own users-API calls send as
		// `Authorization: Bearer` (kimchiOauthApiKey → credential.access; the
		// registered getApiKey reads credentials.access).
		credential: stored.access,
		orgId: extras.orgId,
		...(typeof extras.orgName === "string" && extras.orgName ? { orgName: extras.orgName } : {}),
		...(typeof extras.region === "string" && extras.region ? { region: extras.region } : {}),
		expiry: new Date(stored.expires).toISOString(),
	}
}
