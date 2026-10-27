/**
 * CAST AI SSO login for the kimchi-dev provider: OAuth 2.0 Authorization Code
 * with PKCE (S256) against the per-region CAST AI Auth0 tenant, adapted to
 * the harness's extension OAuth shape (`ExtensionOAuthConfig` from
 * pi-coding-agent, backed by `OAuthLoginCallbacks` from pi-ai).
 *
 * Reuses:
 *  - `startCallbackServer` from `./callback-server.ts` for the loopback server
 *    (shared with the legacy `castai_v1_` key handoff; this module passes
 *    `mode: "code"` so the success branch returns the OAuth code, not a token).
 *  - PKCE (RFC 7636): 32 random bytes base64url, S256 challenge. The helpers
 *    live here because pi-ai does not export them (its package exports map
 *    blocks deep imports), and it ships no reusable OAuth client either — so
 *    the flow itself is implemented here.
 *
 * Long-running sessions renew non-interactively: real expiry plus refresh
 * tokens with rotation handling (see the Refresh lifecycle section of
 * .kimchi/plans/oauth-auth-method.md).
 */

import { createHash, randomBytes } from "node:crypto"
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { CAST_AI_SSO_CALLBACK_PORT, generateOAuthState, startCallbackServer } from "./callback-server.js"

export { generateOAuthState }

import { clearPendingOAuthRegion, type KimchiOAuthConfig, resolveOAuthLoginConfig } from "../oauth-config.js"
import type { RegionId } from "../regions.js"

type ProviderConfigInput = Parameters<ExtensionAPI["registerProvider"]>[1]
type ExtensionOAuthConfig = NonNullable<ProviderConfigInput["oauth"]>

const TOKEN_REQUEST_TIMEOUT_MS = 15_000
/** Subtract from the IdP-reported lifetime so real clock skew never leaves a
 * request starting with a token at the edge of expiry. Upstream refreshes five
 * minutes early; this margin covers the gap between wall clock and IdP clock. */
const EXPIRY_MARGIN_MS = 60_000
/** Scope: offline_access yields the refresh token the harness needs. */
export const OAUTH_SCOPE = "openid profile email offline_access"

const SUCCESS_MESSAGE = "Signed in with CAST AI. You can close this window and return to Kimchi."

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) — 32 random bytes base64url; S256 challenge.
// ---------------------------------------------------------------------------

export function generateCodeVerifier(): string {
	return randomBytes(32).toString("base64url")
}

export function generateCodeChallenge(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url")
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Token-endpoint failure carrying the RFC 6749 `error` code when the server
 * returned one (e.g. "invalid_grant", "access_denied"), so refresh callers can
 * distinguish a dead credential from a transient failure without substring
 * matching (review-lessons: classify by code, not by message).
 */
export class OAuthTokenError extends Error {
	readonly code?: string
	readonly status?: number

	constructor(message: string, options: { code?: string; status?: number } = {}) {
		super(message)
		this.name = "OAuthTokenError"
		this.code = options.code
		this.status = options.status
	}
}

/** True when the error means the refresh token is dead and the user must sign in again. */
export function isInvalidGrantError(error: unknown): boolean {
	return error instanceof OAuthTokenError && error.code === "invalid_grant"
}

// ---------------------------------------------------------------------------
// Authorize URL + manual input parsing
// ---------------------------------------------------------------------------

/**
 * Build the authorization-code URL. `redirectUri` must be the loopback
 * callback this login is listening on.
 */
export function buildAuthorizeUrl(
	config: KimchiOAuthConfig,
	params: { codeChallenge: string; state: string; redirectUri: string },
): string {
	const url = new URL(config.authorizeUrl)
	const search = new URLSearchParams({
		response_type: "code",
		client_id: config.clientId,
		redirect_uri: params.redirectUri,
		scope: OAUTH_SCOPE,
		state: params.state,
		code_challenge: params.codeChallenge,
		code_challenge_method: "S256",
	})
	if (config.audience) search.set("audience", config.audience)
	url.search = search.toString()
	return url.toString()
}

/**
 * Parse a paste-back of the final redirect URL (SSH/headless path): it must
 * point at this login's loopback listener and carry the expected state.
 */
export function authorizationCodeFromManualInput(
	input: string,
	expectedState: string,
	expectedRedirectUri: string,
): { code: string } {
	let url: URL
	try {
		url = new URL(input.trim())
	} catch {
		throw new Error("Paste the full callback URL shown in your browser's address bar after sign-in")
	}
	const expected = new URL(expectedRedirectUri)
	if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
		throw new Error(`The pasted URL must start with ${expectedRedirectUri}`)
	}

	const errorParam = url.searchParams.get("error")
	if (errorParam) {
		const desc = url.searchParams.get("error_description") ?? ""
		throw new OAuthTokenError(`CAST AI sign-in failed: ${errorParam}${desc ? ` — ${desc}` : ""}`, {
			code: errorParam,
		})
	}

	const state = url.searchParams.get("state")
	if (state !== expectedState) {
		throw new Error("The pasted URL does not belong to this sign-in attempt (state mismatch)")
	}
	const code = url.searchParams.get("code")
	if (!code) {
		throw new Error("The pasted URL contains no authorization code")
	}
	return { code }
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

interface TokenResponseBody {
	access_token?: string
	id_token?: string
	refresh_token?: string
	expires_in?: number
	token_type?: string
	scope?: string
	error?: string
	error_description?: string
}

async function postTokenRequest(
	tokenUrl: string,
	params: Record<string, string>,
	signal: AbortSignal,
): Promise<TokenResponseBody> {
	let response: Response
	try {
		response = await fetch(tokenUrl, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(params).toString(),
			signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)]),
		})
	} catch (err) {
		if (signal.aborted) throw new Error("Login cancelled")
		if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
			throw new OAuthTokenError(`Token request to ${tokenUrl} timed out after ${TOKEN_REQUEST_TIMEOUT_MS / 1000}s`)
		}
		const detail = err instanceof Error ? err.message : String(err)
		throw new OAuthTokenError(`Token request to ${tokenUrl} failed: ${detail}`)
	}

	if (!response.ok) {
		const body = (await response.text().catch(() => "")) || response.statusText
		let code: string | undefined
		let description: string | undefined
		try {
			const parsed = JSON.parse(body) as TokenResponseBody
			code = parsed.error
			description = parsed.error_description
		} catch {
			// Non-JSON error body (e.g. proxy HTML) — fall through to the raw text below.
		}
		throw new OAuthTokenError(`Token request failed (${response.status}): ${description ?? code ?? body}`, {
			code,
			status: response.status,
		})
	}

	return (await response.json()) as TokenResponseBody
}

function requireTokenField(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`OAuth token response has invalid ${field}`)
	}
	return value
}

/** Fields the refresh path needs later, stored alongside the credential. */
interface KimchiCredentialExtras {
	region: string
	tokenUrl: string
	clientId: string
	audience?: string
	useIdToken: boolean
	/** Raw tokens, regardless of which one `access` currently carries. */
	idToken?: string
	accessToken?: string
	/** Selected organization (SSO credentials are org-scoped). */
	orgId?: string
	orgName?: string
}

type TokenFlowConfig = Omit<KimchiOAuthConfig, "authorizeUrl" | "organizationsUrl">

function credentialFromTokenResponse(
	token: TokenResponseBody,
	config: TokenFlowConfig,
	previous?: OAuthCredentials & Partial<KimchiCredentialExtras>,
): OAuthCredentials {
	const accessToken = requireTokenField(token.access_token, "access_token")
	const idToken = typeof token.id_token === "string" && token.id_token.trim() ? token.id_token : undefined

	// Rotation: a rotated refresh token replaces the stored one; when the server
	// omits it, the existing token remains valid (previous login / refresh).
	const refresh =
		typeof token.refresh_token === "string" && token.refresh_token.trim() ? token.refresh_token : previous?.refresh
	if (!refresh) {
		throw new Error(
			"CAST AI sign-in did not return a refresh token — the Auth0 application must allow the 'offline_access' scope",
		)
	}
	if (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
		throw new Error("OAuth token response has invalid expires_in")
	}

	const extras: KimchiCredentialExtras = {
		region: config.region,
		tokenUrl: config.tokenUrl,
		clientId: config.clientId,
		useIdToken: config.useIdToken,
		idToken,
		accessToken,
	}
	if (config.audience) extras.audience = config.audience
	// The organization selection survives token refreshes (the org does not
	// change when the access token does).
	if (previous?.orgId) {
		extras.orgId = previous.orgId
		extras.orgName = previous.orgName
	}

	// `access` is what requests send; which token carries it is decided by the
	// useIdToken config (default: ID token as the gateway bearer) pending the V-1 gateway probe.
	const bearer = config.useIdToken ? idToken : accessToken
	if (!bearer) {
		throw new Error("CAST AI sign-in did not return an ID token (KIMCHI_OAUTH_USE_ID_TOKEN=0 to use the access token)")
	}

	return {
		type: "oauth",
		access: bearer,
		refresh,
		expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
		...extras,
	}
}

// ---------------------------------------------------------------------------
// Organization selection
// ---------------------------------------------------------------------------

export interface KimchiOrganization {
	id: string
	name: string
}

interface OrganizationsResponse {
	organizations?: Array<{ id?: string; name?: string }>
}

/** List the user's organizations from the Cast AI users API
 * (`GET <organizationsUrl>` — the Cast AI users API organization listing). */
export async function listUserOrganizations(
	organizationsUrl: string,
	bearer: string,
	signal: AbortSignal,
): Promise<KimchiOrganization[]> {
	let response: Response
	try {
		response = await fetch(organizationsUrl, {
			headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
			signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)]),
		})
	} catch (err) {
		if (signal.aborted) throw new Error("Login cancelled")
		const detail = err instanceof Error ? err.message : String(err)
		throw new Error(`Fetching organizations failed: ${detail}`)
	}
	if (!response.ok) {
		throw new Error(`Fetching organizations failed (HTTP ${response.status})`)
	}
	const body = (await response.json().catch(() => null)) as OrganizationsResponse | null
	const organizations = (body?.organizations ?? [])
		.filter((org) => typeof org?.id === "string" && org.id.trim().length > 0)
		.map((org) => ({ id: org.id as string, name: typeof org.name === "string" ? org.name : (org.id as string) }))
	return organizations
}

/** Sentinel option id for the paginator entry (cannot collide with real
 * CAST AI org ids, which are UUIDs). */
const MORE_ORGANIZATIONS_ID = "__kimchi_more_organizations__"
/** The upstream auth selector renders every option without scrolling, so the
 * org list is paged — 10 organizations per selector page. */
const ORGANIZATION_PAGE_SIZE = 10

/**
 * Pick the organization for a fresh SSO credential: a single
 * organization is auto-selected; multiple prompt via `onSelect` (Esc cancels
 * the whole login); none is an error. Long lists are paged (10 at a time plus
 * a "More organizations…" entry) because the login dialog's selector does not
 * scroll.
 */
export async function selectOrganization(
	organizations: KimchiOrganization[],
	callbacks: OAuthLoginCallbacks,
): Promise<KimchiOrganization> {
	if (organizations.length === 0) {
		throw new Error("This CAST AI account has no organizations")
	}
	if (organizations.length === 1) {
		return organizations[0]
	}
	if (!callbacks.onSelect) {
		throw new Error("This account has multiple organizations; the login surface must offer a selection")
	}
	for (let offset = 0; offset < organizations.length; offset += ORGANIZATION_PAGE_SIZE) {
		const page = organizations.slice(offset, offset + ORGANIZATION_PAGE_SIZE)
		const remaining = organizations.length - (offset + page.length)
		const options = page.map((org) => ({ id: org.id, label: org.name }))
		if (remaining > 0) {
			options.push({ id: MORE_ORGANIZATIONS_ID, label: `More organizations… (${remaining} more)` })
		}
		const selectedId = await callbacks.onSelect({
			message:
				offset === 0
					? "Select organization:"
					: `Select organization (${offset + 1}–${offset + page.length} of ${organizations.length}):`,
			options,
		})
		if (selectedId === undefined) {
			throw new Error("Login cancelled")
		}
		if (selectedId === MORE_ORGANIZATIONS_ID) continue
		const selected = organizations.find((org) => org.id === selectedId)
		if (!selected) {
			throw new Error(`Selected organization ${selectedId} is not available to this account`)
		}
		return selected
	}
	// Unreachable: the loop returns on selection or throws on cancel.
	throw new Error("This CAST AI account has no organizations")
}

// ---------------------------------------------------------------------------
// Public login / refresh / api-key surface
// ---------------------------------------------------------------------------

/**
 * Run the browser-based CAST AI SSO login. Resolves with an OAuth credential
 * the extension adapter stores under `kimchi-dev` in auth.json.
 *
 * `options.callbackPort` is a test seam: omitted (production) it binds the
 * registered fixed port (8765); `0` binds an ephemeral port like the legacy
 * key-handoff flow (the test suite cannot assume 8765 is free — another
 * Kimchi session may legitimately hold it mid-login on a developer's
 * machine). The redirect URI is read from the bound server either way, so
 * nothing else changes between the two modes.
 */
export async function loginWithCastAiOauth(
	config: KimchiOAuthConfig,
	callbacks: OAuthLoginCallbacks,
	options: { callbackPort?: number } = {},
): Promise<OAuthCredentials> {
	const signal = callbacks.signal ?? new AbortController().signal
	const verifier = generateCodeVerifier()
	const state = generateOAuthState()

	const fixedPort = options.callbackPort ?? CAST_AI_SSO_CALLBACK_PORT
	const callbackServer = await startCallbackServer(state, {
		mode: "code",
		successMessage: SUCCESS_MESSAGE,
		// 0 = ephemeral (test seam); any other value = fixed port.
		port: { kind: fixedPort === 0 ? "ephemeral" : "fixed", value: fixedPort },
	})
	const authorizeUrl = buildAuthorizeUrl(config, {
		codeChallenge: generateCodeChallenge(verifier),
		state,
		redirectUri: callbackServer.url,
	})

	callbacks.onAuth({
		url: authorizeUrl,
		instructions:
			"Complete sign-in in your browser. On a remote/SSH session where the callback cannot reach this login server, paste the final redirect URL instead.",
	})

	const manualCode = callbacks
		.onManualCodeInput?.()
		.then((input) => authorizationCodeFromManualInput(input, state, callbackServer.url))

	try {
		const candidates: Array<Promise<{ code: string }>> = [
			callbackServer.result.then((result) => {
				if (result.errorCode) {
					// RFC 6749 error from the IdP — preserve the code so callers can
					// surface "access_denied" vs "interaction_required" vs a transient
					// response_error distinctly.
					throw new OAuthTokenError(
						`CAST AI sign-in failed: ${result.errorCode}${result.error && result.error !== result.errorCode ? ` — ${result.error}` : ""}`,
						{ code: result.errorCode },
					)
				}
				if (result.error) throw new Error(result.error)
				if (!result.code) throw new Error("Callback server returned no code")
				return { code: result.code }
			}),
		]
		if (manualCode) candidates.push(manualCode)
		const { code } = await Promise.race(candidates)

		callbacks.onProgress?.("Exchanging authorization code for tokens…")
		const token = await postTokenRequest(
			config.tokenUrl,
			{
				grant_type: "authorization_code",
				client_id: config.clientId,
				code,
				code_verifier: verifier,
				redirect_uri: callbackServer.url,
				...(config.audience ? { audience: config.audience } : {}),
			},
			signal,
		)
		const credential = credentialFromTokenResponse(token, config)

		// SSO credentials are organization-scoped: list the user's organizations
		// and select one BEFORE the credential is saved, so the
		// stored credential always carries an org id.
		callbacks.onProgress?.("Fetching your organizations…")
		const organizations = await listUserOrganizations(config.organizationsUrl, credential.access, signal)
		const organization = await selectOrganization(organizations, callbacks)
		return { ...credential, orgId: organization.id, orgName: organization.name }
	} catch (error) {
		if (signal.aborted) throw new Error("Login cancelled")
		throw error
	} finally {
		callbackServer.close()
		// race() leaves the losing candidate pending; swallow its rejection so a
		// late manual-prompt failure never crashes the process.
		manualCode?.catch(() => {})
	}
}

/** Config needed to renew a stored credential — carried inside the credential itself. */
function configFromCredential(credential: OAuthCredentials): TokenFlowConfig {
	const extras = credential as OAuthCredentials & Partial<KimchiCredentialExtras>
	if (!extras.tokenUrl || !extras.clientId) {
		throw new Error("Stored CAST AI credential is incomplete — sign in again")
	}
	return {
		region: extras.region as KimchiOAuthConfig["region"],
		tokenUrl: extras.tokenUrl,
		clientId: extras.clientId,
		audience: extras.audience,
		useIdToken: extras.useIdToken ?? true,
	}
}

/**
 * Renew a stored credential with its refresh token (grant_type=refresh_token).
 * Rotation: a new refresh_token in the response replaces the stored one; when
 * absent the current one stays. `invalid_grant` means the credential is dead —
 * the returned error is an OAuthTokenError with code "invalid_grant"; callers
 * surface a re-login prompt (see isInvalidGrantError).
 *
 * Side-effect-free besides the HTTP call: upstream runs this under the
 * credential-store lock and persists the returned credential itself.
 */
export async function refreshCastAiOauth(credential: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const config = configFromCredential(credential)
	const previous = credential as OAuthCredentials & Partial<KimchiCredentialExtras>

	const token = await postTokenRequest(
		config.tokenUrl,
		{
			grant_type: "refresh_token",
			client_id: config.clientId,
			refresh_token: requireTokenField(credential.refresh, "refresh_token"),
			...(config.audience ? { audience: config.audience } : {}),
		},
		signal,
	)
	return credentialFromTokenResponse(token, config, previous)
}

/** The bearer string requests send — what `credentialFromTokenResponse` selected. */
export function castAiOauthApiKey(credential: OAuthCredentials): string {
	return credential.access
}

// ---------------------------------------------------------------------------
// Extension wiring (provider registration)
// ---------------------------------------------------------------------------

export interface KimchiSsoOAuthHooks {
	/**
	 * Called once per refresh attempt that fails with `invalid_grant` — the
	 * refresh token is dead and the user must sign in again. Wire to staleness
	 * marking + a re-login surface. Optional; the OAuthTokenError is rethrown
	 * either way so upstream wraps it as ModelsError("oauth", …).
	 */
	onInvalidGrant?: (credential: OAuthCredentials, error: OAuthTokenError) => void
}

/**
 * Build the provider-level OAuth config (ExtensionOAuthConfig) for the SSO
 * login. `storedRegion` resolves the configured region when the selector did
 * not hand over a pending one (headless surfaces, or a login triggered
 * outside the selector).
 */
export function kimchiSsoExtensionOAuth(
	storedRegion: () => RegionId | undefined,
	hooks: KimchiSsoOAuthHooks = {},
): ExtensionOAuthConfig {
	return {
		name: "CAST AI SSO",
		login: (callbacks) => {
			// Region comes from the selector (pending) or, absent one, config.
			const config = resolveOAuthLoginConfig(storedRegion())
			clearPendingOAuthRegion()
			if (!config) {
				return Promise.reject(
					new Error("CAST AI SSO login is not available for the current region (self-hosted has no SSO tenant)"),
				)
			}
			return loginWithCastAiOauth(config, callbacks)
		},
		refreshToken: async (credentials, signal) => {
			try {
				return await refreshCastAiOauth(credentials, signal)
			} catch (error) {
				if (error instanceof OAuthTokenError && error.code === "invalid_grant") {
					hooks.onInvalidGrant?.(credentials, error)
				}
				throw error
			}
		},
		getApiKey: (credentials) => castAiOauthApiKey(credentials),
	}
}
