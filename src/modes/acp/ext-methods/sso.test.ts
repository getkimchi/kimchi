// Unit tests for the Cast AI SSO ext-method state machine
// (`_kimchi.dev/sso_*`). Most manager cases use injected fakes for every IO
// seam (loopback server, token exchange, org listing, settle tail, clock), so
// those tests cover the wire contract's outcomes without network, ports, or
// real time. The production-listener suite at the end deliberately binds the
// fixed SSO port. Keep fixed-port integration cases in that suite: test files
// run in parallel workers, while these cases run sequentially within this file.

import { createServer, type Server } from "node:http"
import { RequestError } from "@agentclientprotocol/sdk/unstable"
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	CallbackPortInUseError,
	type CallbackResult,
	type CallbackServer,
	KIMCHI_SSO_CALLBACK_PORT,
	startCallbackServer as startRealCallbackServer,
} from "../../../cli-auth/callback-server.js"
import type { KimchiOrganization } from "../../../cli-auth/oauth.js"
import type { KimchiOAuthConfig } from "../../../oauth-config.js"
import { type SsoBeginResponse, type SsoErrorCode, SsoFlowManager, type SsoFlowManagerDeps } from "./sso.js"

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeCallbackServer {
	server: CallbackServer
	settle: (result: CallbackResult) => void
	closeCalls: number
}

function makeFakeCallbackServer(url = "http://localhost:8765/callback"): FakeCallbackServer {
	const fake: FakeCallbackServer = {
		closeCalls: 0,
		settle: () => {},
		server: undefined as unknown as CallbackServer,
	}
	let resolveResult!: (result: CallbackResult) => void
	fake.server = {
		port: 8765,
		url,
		result: new Promise<CallbackResult>((resolve) => {
			resolveResult = resolve
		}),
		close: () => {
			fake.closeCalls++
			resolveResult({ error: "Login cancelled", outcome: "cancelled" })
		},
	}
	fake.settle = resolveResult
	return fake
}

function makeCredential(region: "us" | "eu" = "us"): OAuthCredentials {
	return {
		type: "oauth",
		access: "id-token",
		refresh: "refresh-token",
		expires: Date.now() + 3_600_000,
		region,
		tokenUrl: "https://login.kimchi.dev/oauth/token",
		clientId: "client-id",
		useIdToken: true,
	} as OAuthCredentials
}

interface Harness {
	deps: SsoFlowManagerDeps
	server: FakeCallbackServer
	exchangeAuthorizationCode: ReturnType<typeof vi.fn>
	listUserOrganizations: ReturnType<typeof vi.fn>
	startCallbackServer: ReturnType<typeof vi.fn>
	/** Mutable test clock backing deps.now. */
	clock: { now: number }
	manager: SsoFlowManager
}

function makeHarness(overrides: Partial<SsoFlowManagerDeps> = {}): Harness {
	const server = makeFakeCallbackServer()
	const clock = { now: 1_000_000_000_000 }
	const config: KimchiOAuthConfig = {
		region: "us",
		authorizeUrl: "https://login.kimchi.dev/authorize",
		tokenUrl: "https://login.kimchi.dev/oauth/token",
		clientId: "client-id",
		audience: "https://app.kimchi.dev",
		organizationsUrl: "https://api.cast.ai/v1/organizations",
		useIdToken: true,
	}
	const exchangeAuthorizationCode = vi.fn(
		async (_config: KimchiOAuthConfig, _code: string, _verifier: string, _url: string, _signal: AbortSignal) =>
			makeCredential(),
	)
	const listUserOrganizations = vi.fn(
		async (_url: string, _bearer: string, _signal: AbortSignal): Promise<KimchiOrganization[]> => [
			{ id: "org-1", name: "Acme" },
		],
	)
	const deps: SsoFlowManagerDeps = {
		configuredRegion: () => "us",
		oauthConfigForRegion: (region) =>
			region === "us" || region === "eu"
				? {
						...config,
						region,
						authorizeUrl:
							region === "eu" ? "https://login.eu.kimchi.dev/authorize" : "https://login.kimchi.dev/authorize",
					}
				: undefined,
		startCallbackServer: vi.fn(async () => server.server),
		exchangeAuthorizationCode,
		listUserOrganizations,
		now: () => clock.now,
		...overrides,
	}
	return {
		deps,
		server,
		exchangeAuthorizationCode,
		listUserOrganizations,
		startCallbackServer: deps.startCallbackServer as unknown as ReturnType<typeof vi.fn>,
		clock,
		manager: new SsoFlowManager(deps),
	}
}

/** Assert a rejected promise carries the frozen `data.code` on a -32000
 * JSON-RPC error object. */
async function expectSsoError(promise: Promise<unknown>, code: SsoErrorCode, extra?: Record<string, unknown>) {
	await expect(promise).rejects.toSatisfy((error: unknown) => {
		expect(error).toBeInstanceOf(RequestError)
		const requestError = error as RequestError
		expect(requestError.code).toBe(-32000)
		expect(requestError.data).toMatchObject({ code, ...(extra ?? {}) })
		return true
	})
}

async function expectInvalidParams(promise: Promise<unknown>) {
	await expect(promise).rejects.toSatisfy((error: unknown) => {
		expect(error).toBeInstanceOf(RequestError)
		expect((error as RequestError).code).toBe(-32602)
		return true
	})
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SsoFlowManager", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	describe("sso_begin", () => {
		it("starts the loopback server on the fixed port and returns the authorize URL without opening a browser", async () => {
			const h = makeHarness()

			const begin: SsoBeginResponse = await h.manager.begin({})

			expect(begin.requestId).toBeTruthy()
			// URL shape per the contract: Auth0 authorize endpoint, code + PKCE.
			const url = new URL(begin.authorizeUrl)
			expect(url.origin).toBe("https://login.kimchi.dev")
			expect(url.pathname).toBe("/authorize")
			expect(url.searchParams.get("response_type")).toBe("code")
			expect(url.searchParams.get("code_challenge_method")).toBe("S256")
			expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/)
			expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]+$/)
			expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8765/callback")
			expect(begin.expiresAt).toBe(new Date(h.clock.now + 600_000).toISOString())
			expect(h.deps.startCallbackServer).toHaveBeenCalledWith(expect.any(String), {
				mode: "code",
				successMessage: expect.stringContaining("Cast AI"),
				port: { kind: "fixed", value: 8765 },
			})
		})

		it("uses the configured region when the region param is omitted and the pinned region when given", async () => {
			const h = makeHarness()
			await h.manager.begin({})
			expect(h.exchangeAuthorizationCode).not.toHaveBeenCalled() // sanity: no flow advanced
			const second = makeHarness()
			const begin: SsoBeginResponse = await second.manager.begin({ region: "eu" })
			expect(new URL(begin.authorizeUrl).origin).toBe("https://login.eu.kimchi.dev")
		})

		it("rejects an unknown region with invalid params and a tenant-less region with SSO_UNAVAILABLE_REGION", async () => {
			const h = makeHarness()
			await expectInvalidParams(h.manager.begin({ region: "mars" }))
			await expectSsoError(h.manager.begin({ region: "self-hosted" }), "SSO_UNAVAILABLE_REGION")
		})

		it("rejects with SSO_UNAVAILABLE_REGION when no region is configured", async () => {
			const h = makeHarness({ configuredRegion: () => undefined })
			await expectSsoError(h.manager.begin({}), "SSO_UNAVAILABLE_REGION")
		})

		it("maps a persistent busy callback port to CALLBACK_PORT_BUSY after exactly two attempts", async () => {
			const h = makeHarness({
				portRetryDelayMs: 1,
				startCallbackServer: vi.fn(async () => {
					throw new CallbackPortInUseError(8765)
				}),
			})

			await expectSsoError(h.manager.begin({}), "CALLBACK_PORT_BUSY")
			expect(h.startCallbackServer).toHaveBeenCalledTimes(2)
			// A failed begin leaves the manager free for an explicit user retry;
			// each new begin has its own single-retry budget.
			await expectSsoError(h.manager.begin({}), "CALLBACK_PORT_BUSY")
			expect(h.startCallbackServer).toHaveBeenCalledTimes(4)
		})

		it("returns an ordinary begin response after a transient first busy result", async () => {
			const h = makeHarness({ portRetryDelayMs: 1 })
			h.startCallbackServer.mockRejectedValueOnce(new CallbackPortInUseError(8765))

			const begin = await h.manager.begin({})

			expect(begin).toMatchObject({ requestId: expect.any(String) })
			expect(new URL(begin.authorizeUrl).searchParams.get("redirect_uri")).toBe("http://localhost:8765/callback")
			expect(h.startCallbackServer).toHaveBeenCalledTimes(2)
		})

		// closeServer defers socket destruction (~100ms), so a begin immediately
		// after a cancel/terminal outcome can race the port release. One bounded
		// retry covers the close interval; a held port stops after two attempts.
		it("retries once through the port close interval after a cancelled flow", async () => {
			const h = makeHarness({ portRetryDelayMs: 1 })
			const first = await h.manager.begin({})
			h.manager.cancel({ requestId: first.requestId })
			h.startCallbackServer.mockRejectedValueOnce(new CallbackPortInUseError(8765))

			await expect(h.manager.begin({})).resolves.toMatchObject({ requestId: expect.any(String) })
			expect(h.startCallbackServer).toHaveBeenCalledTimes(3) // first flow + failed attempt + retry
		})

		it("does not use manager-local discard history to suppress an injected retry", async () => {
			const h = makeHarness({ portRetryDelayMs: 1 })
			const first = await h.manager.begin({})
			h.manager.cancel({ requestId: first.requestId })
			h.clock.now += 5_000
			h.startCallbackServer.mockRejectedValueOnce(new CallbackPortInUseError(8765))

			await expect(h.manager.begin({})).resolves.toMatchObject({ requestId: expect.any(String) })
			expect(h.startCallbackServer).toHaveBeenCalledTimes(3)
		})

		it("enforces one flow per connection with SSO_IN_PROGRESS", async () => {
			const h = makeHarness()
			await h.manager.begin({})
			await expectSsoError(h.manager.begin({}), "SSO_IN_PROGRESS")
		})

		// A browser-phase flow whose sso_await was never called has no expiry
		// timer — without reaping, a long-dead flow would block new logins with
		// SSO_IN_PROGRESS (contract: expired → restart the flow).
		it("reaps an expired abandoned flow so a later begin starts cleanly", async () => {
			const h = makeHarness()
			const abandoned = await h.manager.begin({})
			h.clock.now += 600_001

			const retry = await h.manager.begin({})
			expect(retry.requestId).not.toBe(abandoned.requestId)
			// The abandoned flow is dead: its requestId no longer resolves.
			await expectSsoError(h.manager.awaitResult({ requestId: abandoned.requestId }), "SSO_REQUEST_NOT_FOUND")
		})

		it("still rejects SSO_IN_PROGRESS for a live flow even after a previous flow expired", async () => {
			const h = makeHarness()
			await h.manager.begin({})
			await expectSsoError(h.manager.begin({}), "SSO_IN_PROGRESS")
		})
	})

	describe("sso_await", () => {
		it("auto-selects a single organization, settles the credential, and consumes the flow", async () => {
			const h = makeHarness()
			const begin = await h.manager.begin({})
			h.server.settle({ code: "the-code", outcome: "code" })

			await expect(h.manager.awaitResult({ requestId: begin.requestId })).resolves.toEqual({
				status: "authenticated",
				org: { id: "org-1", name: "Acme" },
			})

			expect(h.exchangeAuthorizationCode).toHaveBeenCalledWith(
				expect.objectContaining({ region: "us" }),
				"the-code",
				expect.any(String),
				"http://localhost:8765/callback",
				expect.anything(),
			)
			// The credential rides on the manager for the caller's settle tail,
			// consumed on read.
			expect(h.manager.takeSettledCredential()).toEqual({
				credential: expect.anything(),
				org: { id: "org-1", name: "Acme" },
			})
			expect(h.manager.takeSettledCredential()).toBeUndefined()
			// Consumed: a later await no longer knows the requestId.
			await expectSsoError(h.manager.awaitResult({ requestId: begin.requestId }), "SSO_REQUEST_NOT_FOUND")
		})

		// The Cast AI login page does not scope the session to one org, so
		// multi-org accounts are the norm: the flow parks with the listing and
		// the client completes it via sso_select_org (see "sso_select_org").
		it("settles a multi-org listing as org_selection_required and parks the flow", async () => {
			const h = makeHarness()
			h.listUserOrganizations.mockResolvedValue([
				{ id: "org-123", name: "Acme" },
				{ id: "org-456", name: "Acme Staging" },
			])
			const begin = await h.manager.begin({})
			h.server.settle({ code: "the-code", outcome: "code" })

			await expect(h.manager.awaitResult({ requestId: begin.requestId })).resolves.toEqual({
				status: "org_selection_required",
				organizations: [
					{ id: "org-123", name: "Acme" },
					{ id: "org-456", name: "Acme Staging" },
				],
			})
			// Nothing settles yet — the credential is parked with the flow.
			expect(h.manager.takeSettledCredential()).toBeUndefined()
			// The loopback server is done: its port is released (close called)
			// while the flow itself stays parked.
			expect(h.server.closeCalls).toBeGreaterThan(0)
			// Parked flow still holds the one-flow-per-connection slot...
			await expectSsoError(h.manager.begin({}), "SSO_IN_PROGRESS")
			// ...and a repeat await re-settles the same org list instead of dying.
			await expect(h.manager.awaitResult({ requestId: begin.requestId })).resolves.toEqual({
				status: "org_selection_required",
				organizations: expect.any(Array),
			})
		})

		// A TTL that passes while the exchange/listing is in flight must not
		// park a dead flow: the client would get a list its requestId can no
		// longer act on. The liveness re-check consumes the flow instead, and
		// the slot is released for a fresh begin.
		it("fails SSO_REQUEST_NOT_FOUND instead of parking when the TTL passed mid-completion", async () => {
			const h = makeHarness()
			h.listUserOrganizations.mockImplementation(async () => {
				h.clock.now += 600_001 // TTL passes while the listing is in flight
				return [
					{ id: "org-123", name: "Acme" },
					{ id: "org-456", name: "Acme Staging" },
				]
			})
			const begin = await h.manager.begin({})
			h.server.settle({ code: "the-code", outcome: "code" })

			await expectSsoError(h.manager.awaitResult({ requestId: begin.requestId }), "SSO_REQUEST_NOT_FOUND")
			// Nothing parked, nothing settled, and the connection is free again.
			expect(h.manager.takeSettledCredential()).toBeUndefined()
			await expect(h.manager.begin({})).resolves.toEqual(expect.objectContaining({ requestId: expect.any(String) }))
		})

		// A parked flow outlives its resolved awaitPromise with no active timer,
		// so expiry is only enforced when a call touches it — begin() must reap
		// the expired park (and its credential) instead of failing
		// SSO_IN_PROGRESS forever.
		it("reaps an expired parked flow so a later begin starts cleanly", async () => {
			const h = makeHarness()
			h.listUserOrganizations.mockResolvedValue([
				{ id: "org-123", name: "Acme" },
				{ id: "org-456", name: "Acme Staging" },
			])
			const begin = await h.manager.begin({})
			h.server.settle({ code: "the-code", outcome: "code" })
			await h.manager.awaitResult({ requestId: begin.requestId })
			h.clock.now += 600_001

			const retry = await h.manager.begin({})
			expect(retry.requestId).not.toBe(begin.requestId)
			// The expired park is gone: its requestId no longer resolves and its
			// parked credential was never handed to a settle tail.
			await expectSsoError(h.manager.awaitResult({ requestId: begin.requestId }), "SSO_REQUEST_NOT_FOUND")
			await expectSsoError(
				h.manager.selectOrg({ requestId: begin.requestId, orgId: "org-123" }),
				"SSO_REQUEST_NOT_FOUND",
			)
		})

		// the login page has a region dropdown — a user switching
		// region mid-flow lands on a different tenant and the exchange fails.
		// The SSO_IDP_ERROR must tell them what to do; no cross-tenant handling.
		it("hints at the region switch when the code exchange fails", async () => {
			const h = makeHarness()
			h.exchangeAuthorizationCode.mockRejectedValue(new Error("invalid_grant"))
			const begin = await h.manager.begin({})
			h.server.settle({ code: "the-code", outcome: "code" })
			const error = await h.manager.awaitResult({ requestId: begin.requestId }).then(
				() => {
					throw new Error("expected rejection")
				},
				(e: unknown) => e as RequestError,
			)
			expect(error.message).toContain("switched regions")
			expect(error.message).toContain("start the sign-in again")
		})

		it("maps an IdP error code from the callback to SSO_IDP_ERROR with data.oauthError", async () => {
			const h = makeHarness()
			const begin = await h.manager.begin({})
			h.server.settle({ error: "access_denied", errorCode: "access_denied", outcome: "error" })
			await expectSsoError(h.manager.awaitResult({ requestId: begin.requestId }), "SSO_IDP_ERROR", {
				oauthError: "access_denied",
			})
		})

		it("maps the loopback server's timeout to SSO_CALLBACK_TIMEOUT", async () => {
			const h = makeHarness()
			const begin = await h.manager.begin({})
			h.server.settle({ error: "Browser login timed out -- please try again", outcome: "timeout" })
			await expectSsoError(h.manager.awaitResult({ requestId: begin.requestId }), "SSO_CALLBACK_TIMEOUT")
		})

		it("maps a state-mismatch callback failure to SSO_IDP_ERROR and consumes the flow", async () => {
			const h = makeHarness()
			const begin = await h.manager.begin({})
			h.server.settle({
				error: "OAuth state mismatch — the sign-in attempt was rejected for your protection",
				outcome: "error",
			})
			await expectSsoError(h.manager.awaitResult({ requestId: begin.requestId }), "SSO_IDP_ERROR")
			await expectSsoError(h.manager.awaitResult({ requestId: begin.requestId }), "SSO_REQUEST_NOT_FOUND")
		})

		it("maps an org fetch failure and an empty org list to their typed codes", async () => {
			const failing = makeHarness()
			failing.listUserOrganizations.mockRejectedValue(new Error("HTTP 500"))
			const begin = await failing.manager.begin({})
			failing.server.settle({ code: "the-code", outcome: "code" })
			await expectSsoError(failing.manager.awaitResult({ requestId: begin.requestId }), "SSO_ORG_FETCH_FAILED")

			const empty = makeHarness()
			empty.listUserOrganizations.mockResolvedValue([])
			const begin2 = await empty.manager.begin({})
			empty.server.settle({ code: "the-code", outcome: "code" })
			await expectSsoError(empty.manager.awaitResult({ requestId: begin2.requestId }), "SSO_NO_ORGANIZATIONS")
		})

		it("rejects unknown requestIds with SSO_REQUEST_NOT_FOUND", async () => {
			const h = makeHarness()
			await h.manager.begin({})
			await expectSsoError(h.manager.awaitResult({ requestId: "nope" }), "SSO_REQUEST_NOT_FOUND")
			await expectInvalidParams(h.manager.awaitResult({}))
		})

		it("expires the flow past its TTL and reports SSO_CALLBACK_TIMEOUT on a mid-race expiry", async () => {
			const h = makeHarness()
			const begin = await h.manager.begin({})

			// Expired before await: requestId no longer resolves.
			h.clock.now += 600_001
			await expectSsoError(h.manager.awaitResult({ requestId: begin.requestId }), "SSO_REQUEST_NOT_FOUND")

			// Expired mid-wait: the await race rejects with the timeout code.
			vi.useFakeTimers()
			const h2 = makeHarness({ flowTtlMs: 10 })
			const begin2 = await h2.manager.begin({})
			const pending = h2.manager.awaitResult({ requestId: begin2.requestId })
			// Attach the rejection handler before the timer fires, so the
			// rejection is never momentarily unhandled.
			const expectation = expectSsoError(pending, "SSO_CALLBACK_TIMEOUT")
			await vi.advanceTimersByTimeAsync(20)
			await expectation
		})
	})

	describe("sso_select_org", () => {
		async function parkMultiOrg(h: Harness) {
			h.listUserOrganizations.mockResolvedValue([
				{ id: "org-123", name: "Acme" },
				{ id: "org-456", name: "Acme Staging" },
			])
			const begin = await h.manager.begin({})
			h.server.settle({ code: "the-code", outcome: "code" })
			await h.manager.awaitResult({ requestId: begin.requestId })
			return begin
		}

		it("completes a parked flow with the chosen org and settles the credential once", async () => {
			const h = makeHarness()
			const begin = await parkMultiOrg(h)

			await expect(h.manager.selectOrg({ requestId: begin.requestId, orgId: "org-456" })).resolves.toEqual({
				status: "authenticated",
				org: { id: "org-456", name: "Acme Staging" },
			})

			// The parked credential settles for the caller's settle tail,
			// scoped to the chosen org, consumed on read.
			expect(h.manager.takeSettledCredential()).toEqual({
				credential: expect.anything(),
				org: { id: "org-456", name: "Acme Staging" },
			})
			expect(h.manager.takeSettledCredential()).toBeUndefined()
			// Terminal success consumes the flow.
			await expectSsoError(h.manager.awaitResult({ requestId: begin.requestId }), "SSO_REQUEST_NOT_FOUND")
			await expectSsoError(
				h.manager.selectOrg({ requestId: begin.requestId, orgId: "org-456" }),
				"SSO_REQUEST_NOT_FOUND",
			)
		})

		it("rejects an orgId outside the listing with SSO_UNKNOWN_ORG and keeps the flow parked", async () => {
			const h = makeHarness()
			const begin = await parkMultiOrg(h)

			await expectSsoError(h.manager.selectOrg({ requestId: begin.requestId, orgId: "org-nope" }), "SSO_UNKNOWN_ORG")
			// Non-terminal: the client can retry with a valid id.
			await expect(h.manager.selectOrg({ requestId: begin.requestId, orgId: "org-123" })).resolves.toEqual({
				status: "authenticated",
				org: { id: "org-123", name: "Acme" },
			})
		})

		it("fails SSO_REQUEST_NOT_FOUND on a cancelled, unknown, expired, or browser-phase flow", async () => {
			const h = makeHarness()
			// Cancelled parked flow.
			const cancelled = await parkMultiOrg(h)
			h.manager.cancel({ requestId: cancelled.requestId })
			await expectSsoError(
				h.manager.selectOrg({ requestId: cancelled.requestId, orgId: "org-123" }),
				"SSO_REQUEST_NOT_FOUND",
			)
			// Unknown requestId.
			await expectSsoError(h.manager.selectOrg({ requestId: "nope", orgId: "org-123" }), "SSO_REQUEST_NOT_FOUND")
			// Expired parked flow.
			const expired = await parkMultiOrg(h)
			h.clock.now += 600_001
			await expectSsoError(
				h.manager.selectOrg({ requestId: expired.requestId, orgId: "org-123" }),
				"SSO_REQUEST_NOT_FOUND",
			)
			// Browser phase: the flow is alive but no listing was parked yet.
			const browserPhase = await h.manager.begin({})
			await expectSsoError(
				h.manager.selectOrg({ requestId: browserPhase.requestId, orgId: "org-123" }),
				"SSO_REQUEST_NOT_FOUND",
			)
			// Nothing settled by any of the failed attempts.
			expect(h.manager.takeSettledCredential()).toBeUndefined()
		})

		it("requires both requestId and orgId", async () => {
			const h = makeHarness()
			await expectInvalidParams(h.manager.selectOrg({}))
			await expectInvalidParams(h.manager.selectOrg({ requestId: "req" }))
			await expectInvalidParams(h.manager.selectOrg({ requestId: "req", orgId: "" }))
		})
	})

	describe("sso_cancel", () => {
		it("aborts a mid-wait flow: the pending await rejects and the callback server closes", async () => {
			const h = makeHarness()
			const begin = await h.manager.begin({})
			const pending = h.manager.awaitResult({ requestId: begin.requestId })

			// cancel() is synchronous by contract (returns {} and never throws).
			expect(h.manager.cancel({ requestId: begin.requestId })).toEqual({})

			await expectSsoError(pending, "SSO_REQUEST_NOT_FOUND")
			expect(h.server.closeCalls).toBeGreaterThan(0)
			// The flow is gone: a retry begins cleanly.
			await expect(h.manager.begin({})).resolves.toEqual(expect.objectContaining({ requestId: expect.any(String) }))
		})

		it("is idempotent and never errors for unknown or missing requestIds", async () => {
			const h = makeHarness()
			expect(h.manager.cancel({ requestId: "nope" })).toEqual({})
			expect(h.manager.cancel({})).toEqual({})

			const begin = await h.manager.begin({})
			expect(h.manager.cancel({ requestId: begin.requestId })).toEqual({})
			expect(h.manager.cancel({ requestId: begin.requestId })).toEqual({})
			expect(h.manager.cancel({})).toEqual({})
		})

		// Cancel must stop an in-flight completion, not just the loopback
		// server — a cancelled sign-in must never persist a credential.
		it("aborts an in-flight completion: a cancelled flow never settles", async () => {
			const h = makeHarness()
			h.exchangeAuthorizationCode.mockImplementation(
				(_config: KimchiOAuthConfig, _code: string, _verifier: string, _url: string, signal: AbortSignal) =>
					new Promise<OAuthCredentials>((_resolve, reject) => {
						// cancel() can land before the exchange even starts (abort
						// fires synchronously; an already-aborted signal never
						// dispatches the event).
						if (signal.aborted) {
							reject(new Error("Login cancelled"))
							return
						}
						signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true })
					}),
			)
			const begin = await h.manager.begin({})
			h.server.settle({ code: "the-code", outcome: "code" })
			const pending = h.manager.awaitResult({ requestId: begin.requestId })

			expect(h.manager.cancel({ requestId: begin.requestId })).toEqual({})

			await expectSsoError(pending, "SSO_REQUEST_NOT_FOUND")
			expect(h.manager.takeSettledCredential()).toBeUndefined()
			// The connection is free for a fresh login.
			await expect(h.manager.begin({})).resolves.toEqual(expect.objectContaining({ requestId: expect.any(String) }))
		})

		it("cancels without a requestId targets the active flow", async () => {
			const h = makeHarness()
			const begin = await h.manager.begin({})
			expect(h.manager.cancel({})).toEqual({})
			await expectSsoError(h.manager.awaitResult({ requestId: begin.requestId }), "SSO_REQUEST_NOT_FOUND")
		})
	})

	describe("concurrent awaits", () => {
		it("shares one flow completion across concurrent awaits, exposing the settled credential once", async () => {
			const h = makeHarness()
			const begin = await h.manager.begin({})
			const first = h.manager.awaitResult({ requestId: begin.requestId })
			const second = h.manager.awaitResult({ requestId: begin.requestId })
			h.server.settle({ code: "the-code", outcome: "code" })
			await expect(first).resolves.toEqual({ status: "authenticated", org: { id: "org-1", name: "Acme" } })
			await expect(second).resolves.toEqual({ status: "authenticated", org: { id: "org-1", name: "Acme" } })
			expect(h.manager.takeSettledCredential()).toEqual({
				credential: expect.anything(),
				org: { id: "org-1", name: "Acme" },
			})
			expect(h.manager.takeSettledCredential()).toBeUndefined()
		})
	})
})

// The contention regression lives at the highest existing seam that includes
// both the manager policy and the real fixed-port listener. Delays below come
// only from the production single-retry policy, never from test-side sleeps.
describe("SsoFlowManager with production callback listeners", () => {
	function makeRealHarness(): Harness {
		return makeHarness({ startCallbackServer: startRealCallbackServer })
	}

	async function completeRecoveredBrowserLeg(h: Harness, begin: SsoBeginResponse): Promise<void> {
		expect(begin.requestId).toBeTruthy()
		const authorizeUrl = new URL(begin.authorizeUrl)
		const redirectUri = authorizeUrl.searchParams.get("redirect_uri")
		const state = authorizeUrl.searchParams.get("state")
		expect(redirectUri).toBe(`http://localhost:${KIMCHI_SSO_CALLBACK_PORT}/callback`)
		expect(state).toMatch(/^[0-9a-f]+$/)
		if (!redirectUri || !state) throw new Error("recovered authorize URL omitted redirect or state")

		const callbackUrl = new URL(redirectUri)
		callbackUrl.hostname = "127.0.0.1"
		callbackUrl.searchParams.set("code", "recovered-code")
		callbackUrl.searchParams.set("state", state)
		const response = await fetch(callbackUrl, { signal: AbortSignal.timeout(2_000) })
		expect(response.status).toBe(200)
		await expect(h.manager.awaitResult({ requestId: begin.requestId })).resolves.toEqual({
			status: "authenticated",
			org: { id: "org-1", name: "Acme" },
		})
		expect(h.exchangeAuthorizationCode).toHaveBeenCalledWith(
			expect.objectContaining({ region: "us" }),
			"recovered-code",
			expect.any(String),
			redirectUri,
			expect.anything(),
		)
		expect(h.manager.takeSettledCredential()).toMatchObject({ org: { id: "org-1", name: "Acme" } })
	}

	async function startUnrelatedListener(): Promise<Server> {
		const listener = createServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "text/plain", Connection: "close" })
			response.end("unrelated listener")
		})
		await new Promise<void>((resolveListen, rejectListen) => {
			const onError = (error: Error) => rejectListen(error)
			listener.once("error", onError)
			listener.listen(KIMCHI_SSO_CALLBACK_PORT, "127.0.0.1", () => {
				listener.off("error", onError)
				resolveListen()
			})
		})
		return listener
	}

	async function closeUnrelatedListener(listener: Server): Promise<void> {
		if (!listener.listening) return
		await new Promise<void>((resolveClose) => {
			listener.closeAllConnections()
			listener.close(() => resolveClose())
		})
	}

	it("fails a raw unrelated listener after the bounded retry without disturbing it", async () => {
		const listener = await startUnrelatedListener()
		const h = makeRealHarness()
		try {
			const failure = await h.manager.begin({}).then(
				() => {
					throw new Error("begin unexpectedly returned a request identifier")
				},
				(error: unknown) => error,
			)
			expect(failure).toBeInstanceOf(RequestError)
			expect(failure).not.toHaveProperty("requestId")
			expect((failure as RequestError).data).toMatchObject({ code: "CALLBACK_PORT_BUSY" })
			const message = (failure as RequestError).message
			expect(message).toMatch(/another sign-in or an unrelated application/i)
			expect(message).toMatch(/wait.*released.*try signing in again/i)
			expect(message).not.toMatch(/probably by|another Kimchi session|restart/i)

			// The foreign listener was not killed, taken over, or made unusable.
			const response = await fetch(`http://127.0.0.1:${KIMCHI_SSO_CALLBACK_PORT}/health`, {
				signal: AbortSignal.timeout(2_000),
			})
			expect(response.status).toBe(200)
			expect(await response.text()).toBe("unrelated listener")

			await closeUnrelatedListener(listener)
			// No pending flow survived the failed begin, so this immediate explicit
			// retry reaches the ordinary flow instead of SSO_IN_PROGRESS.
			const recovered = await h.manager.begin({})
			await completeRecoveredBrowserLeg(h, recovered)
		} finally {
			h.manager.cancel({})
			await closeUnrelatedListener(listener)
		}
	})

	it("keeps the same-manager cancel-then-begin real-listener control", async () => {
		const h = makeRealHarness()
		try {
			const first = await h.manager.begin({})
			h.manager.cancel({ requestId: first.requestId })

			const retry = await h.manager.begin({})
			expect(retry.requestId).not.toBe(first.requestId)
			await completeRecoveredBrowserLeg(h, retry)
		} finally {
			h.manager.cancel({})
		}
	})

	it("recovers across independent managers for 20 consecutive real-listener iterations", async () => {
		for (let iteration = 0; iteration < 20; iteration++) {
			const owner = makeRealHarness()
			const competing = makeRealHarness()
			try {
				await owner.manager.begin({})
				await expectSsoError(competing.manager.begin({}), "CALLBACK_PORT_BUSY")

				// B's two failed binds did not disturb A's active listener.
				const activeResponse = await fetch(`http://127.0.0.1:${KIMCHI_SSO_CALLBACK_PORT}/not-a-callback`, {
					signal: AbortSignal.timeout(2_000),
				})
				expect(activeResponse.status).toBe(404)

				owner.manager.cancel({})
				// Deliberately no sleep: B immediately observes A's deferred close,
				// then succeeds through its one automatic retry and normal browser leg.
				// Waiting for a port-released signal here would remove the transient
				// contention this regression is required to exercise.
				const recovered = await competing.manager.begin({})
				await completeRecoveredBrowserLeg(competing, recovered)
			} finally {
				owner.manager.cancel({})
				competing.manager.cancel({})
			}
		}
	}, 60_000)
})
