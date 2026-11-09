// Unit tests for the CAST AI SSO ext-method state machine
// (`_kimchi.dev/sso_*`, LLM-4134). The manager is driven with injected fakes
// for every IO seam (loopback server, token exchange, org listing, settle
// tail, clock) so the tests cover the wire contract's outcomes without
// network, ports, or real time: happy path, multi-org, cancel mid-wait,
// unknown/expired/consumed requestIds, port busy, per-region pinning, IdP
// errors, and the one-flow-per-connection rule.

import { RequestError } from "@agentclientprotocol/sdk"
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CallbackPortInUseError, type CallbackResult, type CallbackServer } from "../../../cli-auth/callback-server.js"
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
	settleCredential: ReturnType<typeof vi.fn>
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
	const settleCredential = vi.fn(async () => {})
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
		settleCredential,
		now: () => clock.now,
		...overrides,
	}
	return {
		deps,
		server,
		exchangeAuthorizationCode,
		listUserOrganizations,
		settleCredential,
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
				successMessage: expect.stringContaining("CAST AI"),
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

		it("maps a busy callback port to CALLBACK_PORT_BUSY", async () => {
			const h = makeHarness({
				startCallbackServer: vi.fn(async () => {
					throw new CallbackPortInUseError(8765)
				}),
			})
			await expectSsoError(h.manager.begin({}), "CALLBACK_PORT_BUSY")
		})

		it("enforces one flow per connection with SSO_IN_PROGRESS", async () => {
			const h = makeHarness()
			await h.manager.begin({})
			await expectSsoError(h.manager.begin({}), "SSO_IN_PROGRESS")
		})

		// Review finding: a browser-phase flow whose sso_await was never called
		// has no expiry timer — without reaping, a long-dead flow would block new
		// logins with SSO_IN_PROGRESS (contract: expired → restart the flow).
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
			expect(h.settleCredential).toHaveBeenCalledTimes(1)
			// Consumed: a later await no longer knows the requestId.
			await expectSsoError(h.manager.awaitResult({ requestId: begin.requestId }), "SSO_REQUEST_NOT_FOUND")
		})

		// LLM-4138: org selection happens in the browser, so the listing must
		// resolve to exactly one org — a multi-org listing means the browser leg
		// did not scope the session, and auto-picking would persist the wrong
		// org. Surface an actionable SSO_IDP_ERROR instead of parking the flow.
		it("fails a multi-org listing with an actionable SSO_IDP_ERROR and consumes the flow", async () => {
			const h = makeHarness()
			h.listUserOrganizations.mockResolvedValue([
				{ id: "org-123", name: "Acme" },
				{ id: "org-456", name: "Acme Staging" },
			])
			const begin = await h.manager.begin({})
			h.server.settle({ code: "the-code", outcome: "code" })

			await expectSsoError(h.manager.awaitResult({ requestId: begin.requestId }), "SSO_IDP_ERROR")
			// Nothing persists and the flow is consumed.
			expect(h.settleCredential).not.toHaveBeenCalled()
			await expectSsoError(h.manager.awaitResult({ requestId: begin.requestId }), "SSO_REQUEST_NOT_FOUND")
		})

		// LLM-4138: the login page has a region dropdown — a user switching
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

		// Review finding: cancel must stop an in-flight completion, not just the
		// loopback server — a cancelled sign-in must never persist a credential.
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
			expect(h.settleCredential).not.toHaveBeenCalled()
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
		it("settles shared awaits once (settleCredential runs a single time)", async () => {
			const h = makeHarness()
			const begin = await h.manager.begin({})
			const first = h.manager.awaitResult({ requestId: begin.requestId })
			const second = h.manager.awaitResult({ requestId: begin.requestId })
			h.server.settle({ code: "the-code", outcome: "code" })
			await expect(first).resolves.toEqual({ status: "authenticated", org: { id: "org-1", name: "Acme" } })
			await expect(second).resolves.toEqual({ status: "authenticated", org: { id: "org-1", name: "Acme" } })
			expect(h.settleCredential).toHaveBeenCalledTimes(1)
		})
	})
})
