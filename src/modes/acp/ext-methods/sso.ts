// ACP extension methods for the Cast AI SSO login.
//
// Wire names: `_kimchi.dev/sso_begin|sso_await|sso_select_org|sso_cancel` —
// sessionless, driven stepwise by the client (Studio) per the frozen wire
// contract (kimchi-studio branch `research/wire-contract-oauth-acp`): the
// browser leg authenticates the user, org selection happens in Studio
// (the `org_selection_required` / `sso_select_org` step; restored from the
// original contract after the LLM-4138 amendment cut it).
//   sso_begin {region?} → {requestId, authorizeUrl, expiresAt}
//       Starts the loopback callback server (fixed port 8765) and builds the
//       Auth0 Authorization Code + PKCE URL. Returns WITHOUT opening a
//       browser — the client opens `authorizeUrl` itself.
//   sso_await {requestId} → {status:"authenticated", org}
//                        | {status:"org_selection_required", organizations}
//       Waits for the browser callback and exchanges the code. With exactly
//       one org in the listing it resolves with that org; with several it
//       settles `org_selection_required` and parks the flow (requestId stays
//       valid) so Studio can offer a picker. The credential rides on the
//       manager for the caller's settle tail (persist + fan-out the
//       org-scoped credential, refresh models/sessions) via
//       takeSettledCredential().
//       Zero organizations is a defensive SSO_NO_ORGANIZATIONS: the stored
//       credential must always carry an org id.
//   sso_select_org {requestId, orgId} → {status:"authenticated", org}
//       Completes a parked org-selection flow: settles the credential scoped
//       to the chosen org (same settle tail as a single-org await). An orgId
//       outside the listing is SSO_UNKNOWN_ORG; a dead/cancelled flow is
//       SSO_REQUEST_NOT_FOUND.
//   sso_cancel {requestId?} → {} — idempotent, never errors.
//
// Region comes from the `region` param (or the configured region), never from
// `setPendingOAuthRegion` — that single-slot global is a TUI selector seam and
// racy with two clients (contract §2). A user switching regions on the login
// page lands on a different tenant and the code exchange fails: surfaced as
// an actionable SSO_IDP_ERROR; no cross-tenant handling.
//
// Errors are JSON-RPC error objects with `data.code` so clients branch on
// machine codes, never message text (contract §3). One flow per connection
// (`SSO_IN_PROGRESS`), mirroring the legacy `AUTH_IN_PROGRESS` rule.

import { RequestError } from "@agentclientprotocol/sdk"
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth"
import {
	CallbackPortInUseError,
	type CallbackResult,
	type CallbackServer,
	KIMCHI_SSO_CALLBACK_PORT,
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
	// `message` rides the standard top-level JSON-RPC error field; it is also
	// duplicated into `data` because contract §3 describes `data: { code,
	// message }` — clients branch on `data.code` but may render `data.message`.
	return new RequestError(SSO_JSON_RPC_ERROR_CODE, message, { code, message, ...extra })
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
 * minutes; 10 minutes bounds the whole flow generously (contract §3.1: "TTL ≈
 * the callback-server lifetime; expiresAt makes it explicit"). */
export const SSO_FLOW_TTL_MS = 600_000

/** Success-page copy shown in the browser after the loopback callback. Same
 * spirit as the ACP Agent Auth copy: client-neutral, no terminal wording. */
const SSO_CALLBACK_SUCCESS_MESSAGE = "Signed in with Cast AI. You can close this window and return to Kimchi."

/** How long after a discard the loopback port may still be draining.
 * closeServer defers socket destruction (~100ms) and server.close() releases
 * the bind asynchronously, so a begin immediately after a cancel/terminal
 * outcome can race the port release. */
const CALLBACK_PORT_DRAIN_WINDOW_MS = 2_000
/** How long to wait before the single drain-retry. */
const CALLBACK_PORT_RETRY_DELAY_MS = 250

export interface SsoFlowManagerDeps {
	/** Region used when `sso_begin` carries none (the configured region). */
	configuredRegion: () => RegionId | undefined
	/** OAuth tenant metadata for a region; undefined → SSO_UNAVAILABLE_REGION. */
	oauthConfigForRegion: (region: RegionId) => KimchiOAuthConfig | undefined
	startCallbackServer: typeof startCallbackServerProd
	exchangeAuthorizationCode: typeof exchangeAuthorizationCodeProd
	listUserOrganizations: typeof listUserOrganizationsProd
	/** Injectable clock for expiry; defaults to Date.now. */
	now?: () => number
	/** Injectable TTL for tests; defaults to {@link SSO_FLOW_TTL_MS}. */
	flowTtlMs?: number
	/** Injectable drain-retry delay for tests; defaults to 250ms. */
	portRetryDelayMs?: number
}

interface PendingSsoFlow {
	requestId: string
	config: KimchiOAuthConfig
	verifier: string
	callbackServer: CallbackServer
	/** Aborted by discard(): cancels an in-flight token exchange or org fetch
	 * so a cancelled sign-in can never complete — sso_cancel stops the whole
	 * continuation, not just the loopback server. */
	abortController: AbortController
	expiresAtMs: number
	/** Shared wait so concurrent/repeat `sso_await` calls settle once. */
	awaitPromise?: Promise<SsoAwaitResponse>
	/** Set when the browser leg settled with a multi-org listing: the
	 * exchanged credential is parked here and the client must complete the
	 * flow with `sso_select_org` (or tear it down with `sso_cancel`). */
	orgSelection?: { credential: OAuthCredentials; organizations: SsoOrganization[] }
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
 * (contract §6.2). The one non-terminal settle is `org_selection_required`:
 * the flow stays parked until the client completes it with `sso_select_org`
 * or tears it down with `sso_cancel`.
 */
export class SsoFlowManager {
	private flow?: PendingSsoFlow
	/** When the last flow was discarded — drives the callback-port drain retry. */
	private lastDiscardedAtMs = 0
	/** Credential + org from the last successful flow, awaiting the caller's
	 * settle tail. Consumed by takeSettledCredential(). */
	private settled?: { credential: OAuthCredentials; org: KimchiOrganization }

	constructor(private readonly deps: SsoFlowManagerDeps) {}

	/** The credential + org settled by the last successful flow, for the
	 * caller's settle tail (persist + fan out + session refresh). Consumed
	 * on read; undefined when nothing settled since. */
	takeSettledCredential(): { credential: OAuthCredentials; org: KimchiOrganization } | undefined {
		const settled = this.settled
		this.settled = undefined
		return settled
	}

	/** `_kimchi.dev/sso_begin` — start the loopback server + build the URL. */
	async begin(params: Record<string, unknown>): Promise<SsoBeginResponse> {
		// Drop any credential left over by an earlier flow whose settle tail the
		// caller never picked up — a new login supersedes it.
		this.settled = undefined
		if (this.flow) {
			// Reap an expired-but-unreaped flow first: a browser-phase flow whose
			// sso_await was never called has nothing watching expiresAtMs — without
			// this, a dead flow would block new logins with SSO_IN_PROGRESS
			// (contract: expired → restart the flow).
			if ((this.deps.now ?? Date.now)() > this.flow.expiresAtMs) {
				this.discard(this.flow)
			} else {
				throw ssoError("SSO_IN_PROGRESS", "A Cast AI SSO sign-in is already in progress on this connection")
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
			throw ssoError("SSO_UNAVAILABLE_REGION", `Cast AI SSO is not available in the ${region} region`)
		}

		const verifier = generateCodeVerifier()
		const state = generateOAuthState()
		let callbackServer: CallbackServer
		try {
			callbackServer = await this.startCallbackServerToleratingDrain(state)
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

	/** `_kimchi.dev/sso_await` — wait for the browser leg and settle. */
	async awaitResult(params: Record<string, unknown>): Promise<SsoAwaitResponse> {
		const requestId = requireStringParam(params, "requestId")
		const flow = this.flowById(requestId)
		flow.awaitPromise ??= this.runBrowserWait(flow)
		return flow.awaitPromise
	}

	/** `_kimchi.dev/sso_select_org` — complete a parked org-selection flow. */
	async selectOrg(params: Record<string, unknown>): Promise<SsoSelectOrgResponse> {
		const requestId = requireStringParam(params, "requestId")
		const orgId = requireStringParam(params, "orgId")
		const flow = this.flowById(requestId)
		const parked = flow.orgSelection
		if (!parked) {
			// The flow is alive but still in the browser phase — the client spoke
			// too early. Same machine code as a dead flow: restart the flow.
			throw ssoError("SSO_REQUEST_NOT_FOUND", "The SSO sign-in has no organization selection pending")
		}
		const org = parked.organizations.find((candidate) => candidate.id === orgId)
		if (!org) {
			// Not terminal: the flow stays parked so the client can retry with a
			// valid orgId (the listing is the source of truth for valid ids).
			throw ssoError("SSO_UNKNOWN_ORG", `This Cast AI account has no organization with id ${orgId}`)
		}
		// The credential rides on the manager for the caller's settle tail
		// (persist + fan out + session refresh) — nothing was written before
		// this point (contract §3.2).
		this.settled = { credential: parked.credential, org }
		// Terminal success consumes the flow.
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
	 * errors; settle either directly (single-org listing → authenticated) or
	 * by parking the flow for the client's org pick
	 * (multi-org → org_selection_required + sso_select_org). */
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
					// completes — cancel stops the whole continuation, not just
					// the loopback server.
					flow.abortController.signal,
				)
			} catch (error) {
				if (flow.abortController.signal.aborted) {
					throw ssoError("SSO_REQUEST_NOT_FOUND", "The SSO sign-in was cancelled")
				}
				// Token-endpoint failures are IdP interactions: map to the typed
				// code (preserving the RFC 6749 error when one came back) instead
				// of an unclassifiable internal error. The region hint is part
				// of the message because the login page has a region dropdown:
				// a user switching region mid-flow lands on a different tenant
				// and the exchange fails — the only fix is restarting the
				// sign-in for the wanted region.
				const detail = error instanceof Error ? error.message : String(error)
				throw ssoError(
					"SSO_IDP_ERROR",
					`Cast AI sign-in failed: ${detail}. If you switched regions on the Cast AI login page, the authorization belongs to a different region — start the sign-in again for the region you want.`,
					error instanceof OAuthTokenError && error.code ? { oauthError: error.code } : undefined,
				)
			}

			// The browser leg authenticated the user but did not pick an org, so
			// the listing is what the client's picker offers (and what
			// sso_select_org validates against).
			let organizations: KimchiOrganization[]
			try {
				organizations = await this.deps.listUserOrganizations(
					flow.config.organizationsUrl,
					credential.access,
					flow.abortController.signal,
				)
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error)
				throw ssoError("SSO_ORG_FETCH_FAILED", `Fetching your Cast AI organizations failed: ${detail}`)
			}
			if (organizations.length === 0) {
				// Defensive: the stored credential must always carry an org id —
				// a browser leg that yields no org cannot be persisted.
				throw ssoError("SSO_NO_ORGANIZATIONS", "This Cast AI account has no organizations")
			}
			if (organizations.length > 1) {
				// The Cast AI login page does not scope the session to one org, so
				// multi-org accounts are the norm. Park the flow: the browser leg
				// stays settled, and the client completes the sign-in by picking an
				// org via sso_select_org (or tears it down with sso_cancel). The
				// loopback server is done — release port 8765 so other Kimchi
				// surfaces can start a sign-in while the pick is pending.
				try {
					flow.callbackServer.close()
				} catch {
					// Already closed — closing is idempotent by contract.
				}
				flow.orgSelection = { credential, organizations }
				return {
					status: "org_selection_required",
					organizations: organizations.map((candidate) => ({ id: candidate.id, name: candidate.name })),
				}
			}
			const org = organizations[0]
			this.assertFlowAlive(flow)
			// The credential rides on the manager for the caller's settle tail
			// (persist + fan out + session refresh) — nothing was written before
			// this point (contract §3.2).
			this.settled = { credential, org }
			// Terminal success consumes the flow.
			this.discard(flow)
			return { status: "authenticated", org }
		} catch (error) {
			// Any terminal failure consumes the flow.
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
			throw ssoError("SSO_IDP_ERROR", `Cast AI sign-in failed: ${result.errorCode}`, {
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
				throw ssoError("SSO_IDP_ERROR", result.error ?? "Cast AI sign-in failed")
		}
		if (!result.code) {
			throw ssoError("SSO_IDP_ERROR", "The OAuth callback carried no authorization code")
		}
	}

	/** Reject with SSO_CALLBACK_TIMEOUT once the flow's TTL passes. The
	 * loopback server resolves its result on its own 5-minute timer, so this
	 * race mainly guards a callback that never arrives on a manager whose flow
	 * TTL is shorter than the server's. */
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

	/** Start the loopback server, retrying once through the drain window: a
	 * begin immediately after a cancel/terminal outcome can otherwise fail with
	 * a spurious CALLBACK_PORT_BUSY while the just-closed server releases port
	 * 8765. A genuinely held port (another Kimchi surface) still fails fast. */
	private async startCallbackServerToleratingDrain(state: string): Promise<CallbackServer> {
		const start = () =>
			this.deps.startCallbackServer(state, {
				mode: "code",
				successMessage: SSO_CALLBACK_SUCCESS_MESSAGE,
				// The redirect URI is registered with Auth0 as exactly
				// http://localhost:8765/callback — the port is non-negotiable.
				port: { kind: "fixed", value: KIMCHI_SSO_CALLBACK_PORT },
			})
		try {
			return await start()
		} catch (error) {
			if (!(error instanceof CallbackPortInUseError)) throw error
			const now = this.deps.now ?? Date.now
			if (now() - this.lastDiscardedAtMs >= CALLBACK_PORT_DRAIN_WINDOW_MS) throw error
			await new Promise((resolve) => setTimeout(resolve, this.deps.portRetryDelayMs ?? CALLBACK_PORT_RETRY_DELAY_MS))
			return start()
		}
	}

	/** Tear down the flow: close the callback server (resolves a pending
	 * browser wait with "Login cancelled", which runBrowserWait maps to
	 * SSO_REQUEST_NOT_FOUND), abort any in-flight completion, and delete the
	 * entry. Safe to call twice. */
	private discard(flow: PendingSsoFlow): void {
		if (this.flow === flow) this.flow = undefined
		this.lastDiscardedAtMs = (this.deps.now ?? Date.now)()
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
