// ACP extension methods for the CAST AI SSO login (LLM-4134).
//
// Wire names: `_kimchi.dev/sso_begin|sso_await|sso_select_org|sso_cancel` —
// sessionless, driven stepwise by the client (Studio) per the frozen wire
// contract (kimchi-studio branch `research/wire-contract-oauth-acp`):
//
//   sso_begin {region?} → {requestId, authorizeUrl, expiresAt}
//       Starts the loopback callback server (fixed port 8765) and builds the
//       Auth0 Authorization Code + PKCE URL. Returns WITHOUT opening a
//       browser — the client opens `authorizeUrl` itself.
//   sso_await {requestId} → {status:"authenticated", org}
//                          | {status:"org_selection_required", organizations}
//       Waits for the browser callback, exchanges the code, lists orgs.
//       Single org auto-selects and settles (persist + fan-out); multi-org
//       holds the token in memory keyed by requestId — nothing is persisted
//       until an org is chosen.
//   sso_select_org {requestId, orgId} → {status:"authenticated", org}
//   sso_cancel {requestId?} → {} — idempotent, never errors.
//
// Region comes from the `region` param (or the configured region), never from
// `setPendingOAuthRegion` — that single-slot global is a TUI selector seam and
// racy with two clients (contract §2).
//
// Errors are JSON-RPC error objects with `data.code` so clients branch on
// machine codes, never message text (contract §3). One flow per connection
// (`SSO_IN_PROGRESS`), mirroring the legacy `AUTH_IN_PROGRESS` rule.

import { RequestError } from "@agentclientprotocol/sdk"
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth"
import {
	CAST_AI_SSO_CALLBACK_PORT,
	CallbackPortInUseError,
	type CallbackResult,
	type CallbackServer,
	type startCallbackServer as startCallbackServerProd,
} from "../../../cli-auth/callback-server.js"
import {
	buildAuthorizeUrl,
	type exchangeAuthorizationCode as exchangeAuthorizationCodeProd,
	generateCodeChallenge,
	generateCodeVerifier,
	generateOAuthState,
	type KimchiOrganization,
	type listUserOrganizations as listUserOrganizationsProd,
	OAuthTokenError,
} from "../../../cli-auth/oauth.js"
import type { KimchiOAuthConfig } from "../../../oauth-config.js"
import { isRegionId, type RegionId } from "../../../regions.js"

// ---------------------------------------------------------------------------
// Typed errors (frozen contract §3 — do not add or rename codes)
// ---------------------------------------------------------------------------

/** Application-level JSON-RPC code for every SSO error; clients MUST branch on
 * `data.code`, never on the numeric code or the message. */
const SSO_JSON_RPC_ERROR_CODE = -32000

/** Machine codes carried in `data.code` of the JSON-RPC error object. */
export type SsoErrorCode =
	| "SSO_IN_PROGRESS"
	| "CALLBACK_PORT_BUSY"
	| "SSO_UNAVAILABLE_REGION"
	| "SSO_REQUEST_NOT_FOUND"
	| "SSO_CALLBACK_TIMEOUT"
	| "SSO_IDP_ERROR"
	| "SSO_ORG_FETCH_FAILED"
	| "SSO_NO_ORGANIZATIONS"
	| "SSO_UNKNOWN_ORG"

export function ssoError(code: SsoErrorCode, message: string, extra?: Record<string, unknown>): RequestError {
	return new RequestError(SSO_JSON_RPC_ERROR_CODE, message, { code, ...extra })
}

// ---------------------------------------------------------------------------
// Wire shapes (frozen contract §3.1–3.4)
// ---------------------------------------------------------------------------

// Type aliases, not interfaces: aliases carry implicit index signatures, so
// handler returns are directly assignable to the extMethod contract's
// `Record<string, unknown>` without casts or spreads.
export type SsoBeginResponse = {
	requestId: string
	authorizeUrl: string
	/** RFC 3339 UTC instant — the flow is dead after this point. */
	expiresAt: string
}

export type SsoOrganization = {
	id: string
	name: string
}

export type SsoAwaitResponse =
	| { status: "authenticated"; org: SsoOrganization }
	| { status: "org_selection_required"; organizations: SsoOrganization[] }

export type SsoSelectOrgResponse = { status: "authenticated"; org: SsoOrganization }

// ---------------------------------------------------------------------------
// Flow manager
// ---------------------------------------------------------------------------

/** Pending-flow TTL. The loopback callback server itself gives up after 5
 * minutes; 10 minutes keeps an `org_selection_required` flow selectable a
 * while longer and bounds the whole flow (contract §3.1: "TTL ≈ the
 * callback-server lifetime; expiresAt makes it explicit"). */
export const SSO_FLOW_TTL_MS = 600_000

/** Success-page copy shown in the browser after the loopback callback. Same
 * spirit as the ACP Agent Auth copy: client-neutral, no terminal wording. */
const SSO_CALLBACK_SUCCESS_MESSAGE = "Signed in with CAST AI. You can close this window and return to Kimchi."

export interface SsoFlowManagerDeps {
	/** Region used when `sso_begin` carries none (the configured region). */
	configuredRegion: () => RegionId | undefined
	/** OAuth tenant metadata for a region; undefined → SSO_UNAVAILABLE_REGION. */
	oauthConfigForRegion: (region: RegionId) => KimchiOAuthConfig | undefined
	startCallbackServer: typeof startCallbackServerProd
	exchangeAuthorizationCode: typeof exchangeAuthorizationCodeProd
	listUserOrganizations: typeof listUserOrganizationsProd
	/**
	 * Settle tail for an authenticated credential: persist + fan out the
	 * org-scoped credential, clear stale marks, refresh model cache and open
	 * sessions. Injected because it touches server-owned state (agentDir,
	 * sessions) and the shared credential store.
	 */
	settleCredential: (credential: OAuthCredentials, org: KimchiOrganization) => Promise<void>
	/** Injectable clock for expiry; defaults to Date.now. */
	now?: () => number
	/** Injectable TTL for tests; defaults to {@link SSO_FLOW_TTL_MS}. */
	flowTtlMs?: number
}

interface PendingSsoFlow {
	requestId: string
	config: KimchiOAuthConfig
	verifier: string
	callbackServer: CallbackServer
	/** Aborted by discard(): cancels an in-flight token exchange or org fetch
	 * so a cancelled sign-in can never complete (review: sso_cancel must stop
	 * the whole continuation, not just the loopback server). */
	abortController: AbortController
	expiresAtMs: number
	/** `browser`: waiting for the loopback callback; `org`: holding the
	 * exchanged token until the client picks an organization. */
	phase: "browser" | "org"
	credential?: OAuthCredentials
	organizations?: KimchiOrganization[]
	/** Shared wait so concurrent/repeat `sso_await` calls settle once. */
	awaitPromise?: Promise<SsoAwaitResponse>
	/** Shared settle so concurrent `sso_select_org` calls persist exactly once
	 * (settleSsoCredential is a read-modify-write of models.json/auth.json). */
	settlePromise?: Promise<SsoSelectOrgResponse>
}

function requireStringParam(params: Record<string, unknown>, name: string): string {
	const value = params[name]
	if (typeof value === "string" && value.length > 0) return value
	throw RequestError.invalidParams(undefined, `${name} is required`)
}

/**
 * State machine for the stepwise SSO ext-method flow. One pending flow per
 * manager (= per ACP connection); a second `sso_begin` while one is alive is
 * `SSO_IN_PROGRESS`. Every terminal outcome (authenticated, IdP error,
 * timeout, cancel) consumes the flow — later calls with the same requestId
 * get `SSO_REQUEST_NOT_FOUND`, which clients treat as "restart the flow"
 * (contract §6.2).
 */
export class SsoFlowManager {
	private flow?: PendingSsoFlow

	constructor(private readonly deps: SsoFlowManagerDeps) {}

	/** `_kimchi.dev/sso_begin` — start the loopback server + build the URL. */
	async begin(params: Record<string, unknown>): Promise<SsoBeginResponse> {
		if (this.flow) {
			// Reap an expired-but-unreaped flow first: a browser-phase flow whose
			// sso_await was never called (or a parked multi-org flow past its
			// window) has nothing watching expiresAtMs — without this, a dead flow
			// would block new logins with SSO_IN_PROGRESS (contract: expired →
			// restart the flow).
			if ((this.deps.now ?? Date.now)() > this.flow.expiresAtMs) {
				this.discard(this.flow)
			} else {
				throw ssoError("SSO_IN_PROGRESS", "A CAST AI SSO sign-in is already in progress on this connection")
			}
		}

		let region: RegionId
		const regionParam = params.region
		if (regionParam === undefined) {
			const configured = this.deps.configuredRegion()
			if (!configured) {
				throw ssoError("SSO_UNAVAILABLE_REGION", "No region is configured; pass an explicit region")
			}
			region = configured
		} else {
			// Unknown region ids are a caller bug → invalid params; known regions
			// without an Auth0 tenant (self-hosted) → SSO_UNAVAILABLE_REGION.
			if (!isRegionId(regionParam)) {
				throw RequestError.invalidParams(undefined, `unknown region: ${String(regionParam)}`)
			}
			region = regionParam
		}
		const config = this.deps.oauthConfigForRegion(region)
		if (!config) {
			throw ssoError("SSO_UNAVAILABLE_REGION", `CAST AI SSO is not available in the ${region} region`)
		}

		const verifier = generateCodeVerifier()
		const state = generateOAuthState()
		let callbackServer: CallbackServer
		try {
			callbackServer = await this.deps.startCallbackServer(state, {
				mode: "code",
				successMessage: SSO_CALLBACK_SUCCESS_MESSAGE,
				// The redirect URI is registered with Auth0 as exactly
				// http://localhost:8765/callback — the port is non-negotiable.
				port: { kind: "fixed", value: CAST_AI_SSO_CALLBACK_PORT },
			})
		} catch (error) {
			if (error instanceof CallbackPortInUseError) {
				throw ssoError(
					"CALLBACK_PORT_BUSY",
					`Port ${error.port} is already in use by another Kimchi sign-in. Cancel that sign-in and try again.`,
				)
			}
			throw error
		}

		const now = this.deps.now ?? Date.now
		const expiresAtMs = now() + (this.deps.flowTtlMs ?? SSO_FLOW_TTL_MS)
		const flow: PendingSsoFlow = {
			requestId: crypto.randomUUID(),
			config,
			verifier,
			callbackServer,
			abortController: new AbortController(),
			expiresAtMs,
			phase: "browser",
		}
		this.flow = flow

		return {
			requestId: flow.requestId,
			authorizeUrl: buildAuthorizeUrl(config, {
				codeChallenge: generateCodeChallenge(verifier),
				state,
				redirectUri: callbackServer.url,
			}),
			expiresAt: new Date(expiresAtMs).toISOString(),
		}
	}

	/** `_kimchi.dev/sso_await` — wait for the browser leg. */
	async awaitResult(params: Record<string, unknown>): Promise<SsoAwaitResponse> {
		const requestId = requireStringParam(params, "requestId")
		const flow = this.flowById(requestId)
		if (flow.phase === "org") {
			// Repeat await while selection is pending: re-serve the same list.
			return { status: "org_selection_required", organizations: [...(flow.organizations ?? [])] }
		}
		flow.awaitPromise ??= this.runBrowserWait(flow)
		return flow.awaitPromise
	}

	/** `_kimchi.dev/sso_select_org` — complete a multi-org login. */
	async selectOrg(params: Record<string, unknown>): Promise<SsoSelectOrgResponse> {
		const requestId = requireStringParam(params, "requestId")
		const orgId = requireStringParam(params, "orgId")
		const flow = this.flowById(requestId)
		if (flow.phase !== "org" || !flow.organizations) {
			this.discard(flow)
			throw ssoError("SSO_REQUEST_NOT_FOUND", "No organization selection is pending for this requestId")
		}
		const org = flow.organizations.find((candidate) => candidate.id === orgId)
		if (!org) {
			throw ssoError("SSO_UNKNOWN_ORG", `Organization ${orgId} is not available to this account`)
		}
		const credential = flow.credential
		if (!credential) {
			// phase "org" always carries the exchanged token; guarded for the
			// type system rather than cast away.
			this.discard(flow)
			throw ssoError("SSO_REQUEST_NOT_FOUND", "No organization selection is pending for this requestId")
		}
		// Memoized settle: concurrent select_org calls share one persist, and a
		// failed settle consumes the flow (same terminal semantics as the
		// single-org branch in runBrowserWait).
		flow.settlePromise ??= this.settleOrg(flow, credential, org)
		return flow.settlePromise
	}

	private async settleOrg(
		flow: PendingSsoFlow,
		credential: OAuthCredentials,
		org: KimchiOrganization,
	): Promise<SsoSelectOrgResponse> {
		this.assertFlowAlive(flow)
		try {
			// Persist + fan out the org-scoped credential; nothing was written
			// before this point (contract §3.2).
			await this.deps.settleCredential(credential, org)
		} catch (error) {
			this.discard(flow)
			throw error
		}
		this.discard(flow)
		return { status: "authenticated", org }
	}

	/** `_kimchi.dev/sso_cancel` — abort mid-flow; idempotent, never errors. */
	cancel(params: Record<string, unknown>): Record<string, never> {
		const requestId = typeof params.requestId === "string" && params.requestId ? params.requestId : undefined
		const flow = requestId ? (this.flow?.requestId === requestId ? this.flow : undefined) : this.flow
		if (flow) this.discard(flow)
		return {}
	}

	// -- internals -----------------------------------------------------------

	/** Look up the live flow by requestId; unknown/expired/consumed → error. */
	private flowById(requestId: string): PendingSsoFlow {
		const flow = this.flow
		if (!flow || flow.requestId !== requestId) {
			throw ssoError("SSO_REQUEST_NOT_FOUND", "Unknown, expired, or already-settled SSO requestId")
		}
		if ((this.deps.now ?? Date.now)() > flow.expiresAtMs) {
			this.discard(flow)
			throw ssoError("SSO_REQUEST_NOT_FOUND", "The SSO sign-in window expired; start the flow again")
		}
		return flow
	}

	/** Race the callback result against the flow TTL; map outcomes to typed
	 * errors; settle single-org flows; park multi-org flows for select_org. */
	private async runBrowserWait(flow: PendingSsoFlow): Promise<SsoAwaitResponse> {
		try {
			const result = await this.raceWithExpiry(flow, flow.callbackServer.result)
			this.assertUsableCallbackResult(result)

			let credential: OAuthCredentials
			try {
				credential = await this.deps.exchangeAuthorizationCode(
					flow.config,
					result.code,
					flow.verifier,
					flow.callbackServer.url,
					// Aborted by sso_cancel/discard so a cancelled sign-in never
					// completes (review finding: cancel must stop the continuation).
					flow.abortController.signal,
				)
			} catch (error) {
				if (flow.abortController.signal.aborted) {
					throw ssoError("SSO_REQUEST_NOT_FOUND", "The SSO sign-in was cancelled")
				}
				// Token-endpoint failures are IdP interactions: map to the typed
				// code (preserving the RFC 6749 error when one came back) instead
				// of an unclassifiable internal error (review finding).
				const detail = error instanceof Error ? error.message : String(error)
				throw ssoError(
					"SSO_IDP_ERROR",
					`CAST AI sign-in failed: ${detail}`,
					error instanceof OAuthTokenError && error.code ? { oauthError: error.code } : undefined,
				)
			}

			let organizations: KimchiOrganization[]
			try {
				organizations = await this.deps.listUserOrganizations(
					flow.config.organizationsUrl,
					credential.access,
					flow.abortController.signal,
				)
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error)
				throw ssoError("SSO_ORG_FETCH_FAILED", `Fetching your CAST AI organizations failed: ${detail}`)
			}
			if (organizations.length === 0) {
				throw ssoError("SSO_NO_ORGANIZATIONS", "This CAST AI account has no organizations")
			}
			if (organizations.length === 1) {
				const org = organizations[0]
				this.assertFlowAlive(flow)
				await this.deps.settleCredential(credential, org)
				// Terminal success consumes the flow.
				this.discard(flow)
				return { status: "authenticated", org }
			}
			// Multi-org: hold the token in memory keyed by requestId — the stored
			// credential must always carry an org id, so nothing persists yet.
			flow.phase = "org"
			flow.credential = credential
			flow.organizations = organizations
			return { status: "org_selection_required", organizations: [...organizations] }
		} catch (error) {
			// Any terminal failure consumes the flow. The org_selection_required
			// path above returns normally, so it keeps the flow alive.
			this.discard(flow)
			if (flow.abortController.signal.aborted && !(error instanceof RequestError)) {
				// The abort surfaced as a plain cancellation error from the token/
				// org fetch — report it as the cancelled requestId it is.
				throw ssoError("SSO_REQUEST_NOT_FOUND", "The SSO sign-in was cancelled")
			}
			throw error
		}
	}

	/** Map a callback-server outcome to either an authorization code or a
	 * typed error, classifying by the typed `outcome` discriminant — never by
	 * matching on message text (same rule as CallbackPortInUseError). */
	private assertUsableCallbackResult(result: CallbackResult): asserts result is CallbackResult & { code: string } {
		if (result.errorCode) {
			// RFC 6749 error from the IdP ("access_denied", "invalid_grant", …) —
			// preserved distinctly so Studio can act on it (contract §3.2).
			throw ssoError("SSO_IDP_ERROR", `CAST AI sign-in failed: ${result.errorCode}`, {
				oauthError: result.errorCode,
			})
		}
		switch (result.outcome) {
			case "timeout":
				throw ssoError("SSO_CALLBACK_TIMEOUT", "The sign-in window timed out before the browser completed")
			case "cancelled":
				throw ssoError("SSO_REQUEST_NOT_FOUND", "The SSO sign-in was cancelled")
			case "code":
			case "token":
				break
			default:
				// "error" (state mismatch, missing deliverable, unexpected server
				// error) or an older server without the discriminant.
				throw ssoError("SSO_IDP_ERROR", result.error ?? "CAST AI sign-in failed")
		}
		if (!result.code) {
			throw ssoError("SSO_IDP_ERROR", "The OAuth callback carried no authorization code")
		}
	}

	/** Reject with SSO_CALLBACK_TIMEOUT once the flow's TTL passes. The
	 * loopback server resolves its result on its own 5-minute timer, so this
	 * race mainly guards the tail (and the parked multi-org window). */
	private raceWithExpiry<T>(flow: PendingSsoFlow, promise: Promise<T>): Promise<T> {
		const now = this.deps.now ?? Date.now
		const remainingMs = flow.expiresAtMs - now()
		if (remainingMs <= 0) {
			return Promise.reject(ssoError("SSO_CALLBACK_TIMEOUT", "The SSO sign-in window expired"))
		}
		let timer: ReturnType<typeof setTimeout> | undefined
		const expiry = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(ssoError("SSO_CALLBACK_TIMEOUT", "The sign-in window timed out before the browser completed"))
			}, remainingMs)
			timer.unref?.()
		})
		return Promise.race([promise, expiry]).finally(() => clearTimeout(timer))
	}

	/** Tear down the flow: close the callback server (resolves a pending
	 * browser wait with "Login cancelled", which runBrowserWait maps to
	 * SSO_REQUEST_NOT_FOUND), abort any in-flight completion, and delete the
	 * entry. Safe to call twice. */
	private discard(flow: PendingSsoFlow): void {
		if (this.flow === flow) this.flow = undefined
		flow.abortController.abort()
		try {
			flow.callbackServer.close()
		} catch {
			// The server may already be closed — idempotent by contract.
		}
	}

	/** Refuse to settle a flow that was cancelled/expired while its completion
	 * was in flight: discard() cleared the map entry, so a missing entry means
	 * the credential must not be persisted. */
	private assertFlowAlive(flow: PendingSsoFlow): void {
		if (this.flow !== flow) {
			throw ssoError("SSO_REQUEST_NOT_FOUND", "The SSO sign-in was cancelled")
		}
	}
}
