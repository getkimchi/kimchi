import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { KimchiOAuthConfig } from "../oauth-config.js"
import {
	authorizationCodeFromManualInput,
	buildAuthorizeUrl,
	generateCodeChallenge,
	generateCodeVerifier,
	generateOAuthState,
	isInvalidGrantError,
	loginWithCastAiOauth,
	OAuthTokenError,
	refreshCastAiOauth,
} from "./oauth.js"

// ---------------------------------------------------------------------------
// Mock authorization server (token endpoint), capturing requests for asserts.
// ---------------------------------------------------------------------------

interface RecordedTokenRequest {
	params: URLSearchParams
}

interface MockTokenServer {
	server: Server
	url: string
	requests: RecordedTokenRequest[]
	respond: (params: URLSearchParams) => { status: number; body: unknown }
	setResponder(fn: (params: URLSearchParams) => { status: number; body: unknown }): void
	/** Organizations served on GET /v1/organizations. */
	organizations: Array<{ id: string; name: string }>
	setOrganizations: (orgs: Array<{ id: string; name: string }>) => void
	orgRequests: Array<{ authorization: string | null }>
	close(): Promise<void>
}

function startMockTokenServer(): Promise<MockTokenServer> {
	const mock: Partial<MockTokenServer> = {
		requests: [],
		organizations: [{ id: "org-default", name: "Default Org" }],
		orgRequests: [],
	}
	mock.respond = (params) => {
		expect(params.get("refresh_token")).toBe("rt-1")
		return {
			status: 200,
			body: { access_token: "at-2", id_token: "id-2", refresh_token: "rt-2", expires_in: 3600 },
		}
	}
	mock.setResponder = (fn) => {
		mock.respond = fn
	}
	mock.setOrganizations = (orgs) => {
		mock.organizations = orgs
	}
	return new Promise<MockTokenServer>((resolve, reject) => {
		const server = createServer((req, res) => {
			if (req.method === "GET" && req.url?.split("?")[0] === "/v1/organizations") {
				mock.orgRequests?.push({ authorization: req.headers.authorization ?? null })
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify({ organizations: mock.organizations }))
				return
			}
			if (req.method !== "POST" || req.url === undefined) {
				res.writeHead(404).end()
				return
			}
			let body = ""
			req.setEncoding("utf-8")
			req.on("data", (chunk) => {
				body += chunk
			})
			req.on("end", () => {
				const params = new URLSearchParams(body)
				mock.requests?.push({ params })
				const { status, body: responseBody } = (mock.respond ?? (() => ({ status: 500, body: {} })))(params)
				res.writeHead(status, { "content-type": "application/json" })
				res.end(JSON.stringify(responseBody))
			})
			req.on("error", reject)
		})
		server.on("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo
			resolve({
				server,
				url: `http://127.0.0.1:${port}`,
				requests: mock.requests as RecordedTokenRequest[],
				respond: mock.respond as MockTokenServer["respond"],
				setResponder: mock.setResponder as MockTokenServer["setResponder"],
				organizations: mock.organizations as Array<{ id: string; name: string }>,
				setOrganizations: mock.setOrganizations as MockTokenServer["setOrganizations"],
				orgRequests: mock.orgRequests as Array<{ authorization: string | null }>,
				close: () =>
					new Promise<void>((done) => {
						server.closeAllConnections?.()
						server.close(() => done())
					}),
			})
		})
	})
}

function configFor(tokenUrl: string, overrides: Partial<KimchiOAuthConfig> = {}): KimchiOAuthConfig {
	return {
		region: "us",
		authorizeUrl: "https://login.kimchi.dev/authorize",
		tokenUrl: `${tokenUrl}/token`,
		organizationsUrl: `${tokenUrl}/v1/organizations`,
		clientId: "test-client",
		useIdToken: true,
		...overrides,
	}
}

/** The fixed production port (8765) is the registered Auth0 redirect URI.
 * Tests cannot use it: another Kimchi session may legitimately hold it
 * mid-login on a developer's machine. Every login below binds an ephemeral
 * port instead (callbackPort: 0) — the redirect URI is read back from the
 * bound server, so the flow is identical apart from the port. */
function login(config: KimchiOAuthConfig, callbacks: OAuthLoginCallbacks) {
	return loginWithCastAiOauth(config, callbacks, { callbackPort: 0 })
}

function makeCallbacks(overrides: Partial<OAuthLoginCallbacks> = {}) {
	const authUrls: string[] = []
	const callbacks: OAuthLoginCallbacks = {
		onAuth: (info) => authUrls.push(info.url),
		onPrompt: () => Promise.reject(new Error("unexpected prompt")),
		onSelect: () => Promise.reject(new Error("unexpected select")),
		onDeviceCode: () => {},
		signal: new AbortController().signal,
		...overrides,
	}
	return { callbacks, authUrls }
}

/** Extract the loopback redirect_uri + state out of the surfaced authorize URL. */
function authorizeUrlParts(authUrl: string): { state: string; redirectUri: string } {
	const url = new URL(authUrl)
	return {
		state: url.searchParams.get("state") as string,
		redirectUri: url.searchParams.get("redirect_uri") as string,
	}
}

/** Drive the browser leg: hit the login's loopback server like an IdP redirect
 * would. The advertised redirect URI uses `localhost`; the server binds
 * loopback IPv4, so the probe targets 127.0.0.1 directly. */
async function driveBrowserCallback(redirectUri: string, params: Record<string, string>): Promise<void> {
	const url = new URL(redirectUri)
	url.hostname = "127.0.0.1"
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
	await fetch(url)
}

let mock: MockTokenServer
beforeEach(async () => {
	mock = await startMockTokenServer()
})
afterEach(async () => {
	await mock.close()
})

describe("PKCE", () => {
	it("generates an RFC 7636 verifier and S256 challenge (appendix B vector)", () => {
		const verifier = generateCodeVerifier()
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(generateCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
			"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		)
	})

	it("generates distinct states", () => {
		expect(generateOAuthState()).not.toBe(generateOAuthState())
	})
})

describe("buildAuthorizeUrl", () => {
	it("builds the authorization-code + PKCE URL with offline_access scope", () => {
		const url = new URL(
			buildAuthorizeUrl(configFor("http://127.0.0.1:1"), {
				codeChallenge: "challenge-x",
				state: "state-y",
				redirectUri: "http://127.0.0.1:1234/callback",
			}),
		)
		expect(url.origin).toBe("https://login.kimchi.dev")
		expect(url.pathname).toBe("/authorize")
		expect(url.searchParams.get("response_type")).toBe("code")
		expect(url.searchParams.get("client_id")).toBe("test-client")
		expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1234/callback")
		expect(url.searchParams.get("scope")).toBe("openid profile email offline_access")
		expect(url.searchParams.get("state")).toBe("state-y")
		expect(url.searchParams.get("code_challenge")).toBe("challenge-x")
		expect(url.searchParams.get("code_challenge_method")).toBe("S256")
		expect(url.searchParams.has("audience")).toBe(false)
	})

	it("includes audience when configured", () => {
		const url = new URL(
			buildAuthorizeUrl(configFor("http://127.0.0.1:1", { audience: "https://llm.kimchi.dev" }), {
				codeChallenge: "c",
				state: "s",
				redirectUri: "http://127.0.0.1:1/callback",
			}),
		)
		expect(url.searchParams.get("audience")).toBe("https://llm.kimchi.dev")
	})
})

describe("authorizationCodeFromManualInput", () => {
	const redirectUri = "http://127.0.0.1:4321/callback"

	it("extracts the code from a pasted redirect URL", () => {
		expect(authorizationCodeFromManualInput(`${redirectUri}?code=abc&state=st-1`, "st-1", redirectUri).code).toBe("abc")
	})

	it("rejects non-URL input with guidance", () => {
		expect(() => authorizationCodeFromManualInput("not a url", "st-1", redirectUri)).toThrow(/full callback URL/)
	})

	it("rejects a URL for a different login server", () => {
		expect(() =>
			authorizationCodeFromManualInput(`http://127.0.0.1:9999/callback?code=x&state=st-1`, "st-1", redirectUri),
		).toThrow(/must start with/)
	})

	it("rejects a state mismatch", () => {
		expect(() => authorizationCodeFromManualInput(`${redirectUri}?code=x&state=other`, "st-1", redirectUri)).toThrow(
			/state mismatch/,
		)
	})

	it("surfaces IdP errors as OAuthTokenError with their code", () => {
		let error: unknown
		try {
			authorizationCodeFromManualInput(
				`${redirectUri}?error=access_denied&error_description=nope&state=st-1`,
				"st-1",
				redirectUri,
			)
		} catch (err) {
			error = err
		}
		expect(error).toBeInstanceOf(OAuthTokenError)
		expect((error as OAuthTokenError).code).toBe("access_denied")
		expect((error as OAuthTokenError).message).toContain("nope")
	})

	it("rejects URLs without a code", () => {
		expect(() => authorizationCodeFromManualInput(`${redirectUri}?state=st-1`, "st-1", redirectUri)).toThrow(
			/no authorization code/,
		)
	})
})

describe("loginWithCastAiOauth", () => {
	it("fails with guidance when the chosen callback port is already in use", async () => {
		// Bind a server on an ephemeral port, then point the login at that exact
		// port so its callback server hits EADDRINUSE (the fixed production
		// port cannot be used here — see the login() helper note above).
		const blocker = createServer()
		const blockerPort = await new Promise<number>((resolveListen) =>
			blocker.listen(0, "127.0.0.1", () => resolveListen((blocker.address() as AddressInfo).port)),
		)
		try {
			const { callbacks } = makeCallbacks()
			await expect(loginWithCastAiOauth(configFor(mock.url), callbacks, { callbackPort: blockerPort })).rejects.toThrow(
				new RegExp(`${blockerPort} is in use, probably by an unfinished CAST AI sign-in`),
			)
		} finally {
			await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()))
		}
	})
	it("surfaces the authorize URL with PKCE/scope params through onAuth", async () => {
		const { callbacks, authUrls } = makeCallbacks()
		const loginPromise = login(configFor(mock.url), callbacks)
		// Attach the rejection assertion eagerly: the callback-driven rejection
		// must not settle without a handler (vitest flags those as unhandled).
		const rejection = expect(loginPromise).rejects.toThrow(/access_denied/)
		await vi.waitFor(() => expect(authUrls).toHaveLength(1))
		const authUrl = new URL(authUrls[0])
		expect(authUrl.searchParams.get("response_type")).toBe("code")
		expect(authUrl.searchParams.get("scope")).toContain("offline_access")
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256")
		// The authorize URL's redirect_uri mirrors the bound ephemeral port and
		// uses the `localhost` host form. The production fixed port (8765,
		// the production fixed redirect URI is exercised via the KIMCHI_SSO_REDIRECT_URI constant.
		expect(authUrl.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/callback$/)
		const { state, redirectUri } = authorizeUrlParts(authUrls[0])
		await driveBrowserCallback(redirectUri, { error: "access_denied", error_description: "user cancelled", state })
		await rejection
	})

	it("completes the code exchange and returns a full credential (default: ID token as access)", async () => {
		mock.setResponder((params) => {
			expect(params.get("grant_type")).toBe("authorization_code")
			expect(params.get("client_id")).toBe("test-client")
			expect(params.get("code")).toBe("auth-code-1")
			expect(params.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/)
			return { status: 200, body: { access_token: "at-1", id_token: "id-1", refresh_token: "rt-1", expires_in: 3600 } }
		})
		const { callbacks, authUrls } = makeCallbacks()
		const loginPromise = login(configFor(mock.url), callbacks)

		await vi.waitFor(() => expect(authUrls).toHaveLength(1))
		const { state, redirectUri } = authorizeUrlParts(authUrls[0])
		await driveBrowserCallback(redirectUri, { code: "auth-code-1", state })

		const before = Date.now() - 1000
		const credential = await loginPromise
		expect(credential.access).toBe("id-1") // useIdToken default
		expect(credential.refresh).toBe("rt-1")
		expect(credential.expires).toBeGreaterThan(before + 3600_000 - 65_000)
		expect(credential.expires).toBeLessThanOrEqual(Date.now() + 3600_000 - 55_000)
		// Extras required for later refresh.
		expect(credential).toMatchObject({
			region: "us",
			tokenUrl: `${mock.url}/token`,
			clientId: "test-client",
			useIdToken: true,
			idToken: "id-1",
			accessToken: "at-1",
		})
		// A single organization is auto-selected and stored
		// with the credential; the org listing was fetched with the bearer.
		expect(credential.orgId).toBe("org-default")
		expect(credential.orgName).toBe("Default Org")
		expect(mock.orgRequests).toEqual([{ authorization: "Bearer id-1" }])
		expect(mock.requests).toHaveLength(1)
	})

	it("prompts for the organization when the account has several and stores the selection", async () => {
		mock.setOrganizations([
			{ id: "org-a", name: "Alpha Org" },
			{ id: "org-b", name: "Beta Org" },
		])
		mock.setResponder(() => ({
			status: 200,
			body: { access_token: "at-1", id_token: "id-1", refresh_token: "rt-1", expires_in: 3600 },
		}))
		const selections: Array<{ message: string; options: Array<{ id: string; label: string }> }> = []
		const { callbacks, authUrls } = makeCallbacks({
			onSelect: async (prompt) => {
				selections.push({ message: prompt.message, options: prompt.options })
				return "org-b"
			},
		})
		const loginPromise = login(configFor(mock.url), callbacks)
		await vi.waitFor(() => expect(authUrls).toHaveLength(1))
		const { state, redirectUri } = authorizeUrlParts(authUrls[0])
		await driveBrowserCallback(redirectUri, { code: "c", state })
		const credential = await loginPromise
		expect(selections).toEqual([
			{
				message: "Select organization:",
				options: [
					{ id: "org-a", label: "Alpha Org" },
					{ id: "org-b", label: "Beta Org" },
				],
			},
		])
		expect(credential.orgId).toBe("org-b")
		expect(credential.orgName).toBe("Beta Org")
	})

	it("pages long organization lists through the selector instead of overflowing it", async () => {
		const orgs = Array.from({ length: 25 }, (_, i) => ({ id: `org-${i + 1}`, name: `Org ${i + 1}` }))
		mock.setOrganizations(orgs)
		mock.setResponder(() => ({
			status: 200,
			body: { access_token: "at-1", id_token: "id-1", refresh_token: "rt-1", expires_in: 3600 },
		}))
		const pages: Array<Array<{ id: string; label: string }>> = []
		let call = 0
		const { callbacks, authUrls } = makeCallbacks({
			onSelect: async (prompt) => {
				pages.push(prompt.options)
				// First page: walk to the "More organizations…" entry (last option).
				if (call === 0) {
					call += 1
					return prompt.options[prompt.options.length - 1]?.id
				}
				// Second page: pick the 13th organization overall.
				call += 1
				return "org-13"
			},
		})
		const loginPromise = login(configFor(mock.url), callbacks)
		await vi.waitFor(() => expect(authUrls).toHaveLength(1))
		const { state, redirectUri } = authorizeUrlParts(authUrls[0])
		await driveBrowserCallback(redirectUri, { code: "c", state })
		const credential = await loginPromise

		// The first page is capped at 10 organizations + the paginator entry —
		// the upstream auth selector does not scroll, so this bounds the dialog.
		expect(pages[0]).toHaveLength(11)
		expect(pages[0]?.[9]).toEqual({ id: "org-10", label: "Org 10" })
		expect(pages[0]?.[10]?.id).toBe("__kimchi_more_organizations__")
		expect(pages[0]?.[10]?.label).toContain("15 more")
		// The second page continues where the first ended.
		expect(pages[1]?.[0]).toEqual({ id: "org-11", label: "Org 11" })
		expect(credential.orgId).toBe("org-13")
		expect(credential.orgName).toBe("Org 13")
	})

	it("cancels the login when the organization selection is dismissed", async () => {
		mock.setOrganizations([
			{ id: "org-a", name: "Alpha Org" },
			{ id: "org-b", name: "Beta Org" },
		])
		mock.setResponder(() => ({
			status: 200,
			body: { access_token: "at-1", id_token: "id-1", refresh_token: "rt-1", expires_in: 3600 },
		}))
		const { callbacks, authUrls } = makeCallbacks({ onSelect: async () => undefined })
		const loginPromise = login(configFor(mock.url), callbacks)
		const rejection = expect(loginPromise).rejects.toThrow("Login cancelled")
		await vi.waitFor(() => expect(authUrls).toHaveLength(1))
		const { state, redirectUri } = authorizeUrlParts(authUrls[0])
		await driveBrowserCallback(redirectUri, { code: "c", state })
		await rejection
	})

	it("fails with guidance when the account has no organizations", async () => {
		mock.setOrganizations([])
		mock.setResponder(() => ({
			status: 200,
			body: { access_token: "at-1", id_token: "id-1", refresh_token: "rt-1", expires_in: 3600 },
		}))
		const { callbacks, authUrls } = makeCallbacks()
		const loginPromise = login(configFor(mock.url), callbacks)
		const rejection = expect(loginPromise).rejects.toThrow(/no organizations/)
		await vi.waitFor(() => expect(authUrls).toHaveLength(1))
		const { state, redirectUri } = authorizeUrlParts(authUrls[0])
		await driveBrowserCallback(redirectUri, { code: "c", state })
		await rejection
	})

	it("uses the access token as the bearer when useIdToken is false", async () => {
		mock.setResponder(() => ({
			status: 200,
			body: { access_token: "at-9", id_token: "id-9", refresh_token: "rt-9", expires_in: 600 },
		}))
		const { callbacks, authUrls } = makeCallbacks()
		const loginPromise = login(configFor(mock.url, { useIdToken: false }), callbacks)
		await vi.waitFor(() => expect(authUrls).toHaveLength(1))
		const { state, redirectUri } = authorizeUrlParts(authUrls[0])
		await driveBrowserCallback(redirectUri, { code: "c", state })
		expect((await loginPromise).access).toBe("at-9")
	})

	it("fails closed when the response has no refresh token (offline_access missing)", async () => {
		mock.setResponder(() => ({ status: 200, body: { access_token: "at", id_token: "id", expires_in: 60 } }))
		const { callbacks, authUrls } = makeCallbacks()
		const loginPromise = login(configFor(mock.url), callbacks)
		const rejection = expect(loginPromise).rejects.toThrow(/offline_access/)
		await vi.waitFor(() => expect(authUrls).toHaveLength(1))
		const { state, redirectUri } = authorizeUrlParts(authUrls[0])
		await driveBrowserCallback(redirectUri, { code: "c", state })
		await rejection
	})

	it("rejects on callback state mismatch", async () => {
		const { callbacks, authUrls } = makeCallbacks()
		const loginPromise = login(configFor(mock.url), callbacks)
		const rejection = expect(loginPromise).rejects.toThrow(/state mismatch/)
		await vi.waitFor(() => expect(authUrls).toHaveLength(1))
		const { redirectUri } = authorizeUrlParts(authUrls[0])
		await driveBrowserCallback(redirectUri, { code: "c", state: "wrong-state" })
		await rejection
	})

	it("maps RFC 6749 token-endpoint errors (code + description)", async () => {
		mock.setResponder(() => ({ status: 400, body: { error: "invalid_grant", error_description: "expired code" } }))
		const { callbacks, authUrls } = makeCallbacks()
		const loginPromise = login(configFor(mock.url), callbacks)
		const rejection = loginPromise.catch((err: unknown) => err)
		await vi.waitFor(() => expect(authUrls).toHaveLength(1))
		const { state, redirectUri } = authorizeUrlParts(authUrls[0])
		await driveBrowserCallback(redirectUri, { code: "dead-code", state })
		const error = await rejection
		expect(error).toBeInstanceOf(OAuthTokenError)
		expect((error as OAuthTokenError).code).toBe("invalid_grant")
		expect((error as OAuthTokenError).message).toContain("expired code")
	})

	it("completes via the manual paste-back path (SSH/headless)", async () => {
		mock.setResponder((params) => {
			expect(params.get("code")).toBe("manual-code-1")
			return { status: 200, body: { access_token: "at-m", id_token: "id-m", refresh_token: "rt-m", expires_in: 120 } }
		})
		const { callbacks, authUrls } = makeCallbacks({
			onManualCodeInput: () => {
				// Wait for the URL (and thus the loopback port) to be known.
				return new Promise((resolve) => {
					vi.waitFor(() => {
						expect(authUrls).toHaveLength(1)
					}).then(() => {
						const { state, redirectUri } = authorizeUrlParts(authUrls[0])
						resolve(`${redirectUri}?code=manual-code-1&state=${state}`)
					})
				})
			},
		})
		const credential = await login(configFor(mock.url), callbacks)
		expect(credential.refresh).toBe("rt-m")
		expect(mock.requests).toHaveLength(1)
	})

	it("passes the audience to the token request when configured", async () => {
		mock.setResponder((params) => {
			expect(params.get("audience")).toBe("https://llm.kimchi.dev")
			return { status: 200, body: { access_token: "a", id_token: "i", refresh_token: "r", expires_in: 300 } }
		})
		const { callbacks, authUrls } = makeCallbacks()
		const loginPromise = login(configFor(mock.url, { audience: "https://llm.kimchi.dev" }), callbacks)
		await vi.waitFor(() => expect(authUrls).toHaveLength(1))
		const { state, redirectUri } = authorizeUrlParts(authUrls[0])
		await driveBrowserCallback(redirectUri, { code: "c", state })
		await loginPromise
		expect(mock.requests).toHaveLength(1)
	})
})

describe("refreshCastAiOauth", () => {
	const storedCredential = {
		type: "oauth" as const,
		access: "id-1",
		refresh: "rt-1",
		expires: Date.now() - 1000,
		region: "us",
		tokenUrl: "",
		clientId: "test-client",
		useIdToken: true,
		idToken: "id-1",
		accessToken: "at-1",
		orgId: "org-default",
		orgName: "Default Org",
	}

	it("renews with grant_type=refresh_token and rotates the refresh token", async () => {
		const credential = { ...storedCredential, tokenUrl: `${mock.url}/token` }
		const before = Date.now() - 1000
		const next = await refreshCastAiOauth(credential, new AbortController().signal)
		expect(mock.requests).toHaveLength(1)
		expect(mock.requests[0].params.get("grant_type")).toBe("refresh_token")
		expect(mock.requests[0].params.get("refresh_token")).toBe("rt-1")
		expect(next.refresh).toBe("rt-2")
		expect(next.access).toBe("id-2")
		expect(next.expires).toBeGreaterThan(before + 3600_000 - 65_000)
		// The organization selection survives token refreshes.
		expect(next.orgId).toBe("org-default")
		expect(next.orgName).toBe("Default Org")
	})

	it("keeps the existing refresh token when the server rotates silently (no refresh_token in response)", async () => {
		mock.setResponder(() => ({
			status: 200,
			body: { access_token: "at-3", id_token: "id-3", expires_in: 3600 },
		}))
		const credential = { ...storedCredential, tokenUrl: `${mock.url}/token` }
		const next = await refreshCastAiOauth(credential, new AbortController().signal)
		expect(next.refresh).toBe("rt-1")
	})

	it("throws OAuthTokenError with code invalid_grant for a dead refresh token", async () => {
		mock.setResponder(() => ({
			status: 400,
			body: { error: "invalid_grant", error_description: "refresh token revoked" },
		}))
		const credential = { ...storedCredential, tokenUrl: `${mock.url}/token` }
		const error = await refreshCastAiOauth(credential, new AbortController().signal).catch((err: unknown) => err)
		expect(isInvalidGrantError(error)).toBe(true)
		expect((error as OAuthTokenError).message).toContain("refresh token revoked")
	})

	it("passes transient failures through without the invalid_grant classification", async () => {
		mock.setResponder(() => ({ status: 500, body: { error: "server_error" } }))
		const credential = { ...storedCredential, tokenUrl: `${mock.url}/token` }
		const error = await refreshCastAiOauth(credential, new AbortController().signal).catch((err: unknown) => err)
		expect(isInvalidGrantError(error)).toBe(false)
		expect((error as OAuthTokenError).status).toBe(500)
	})

	it("fails with a re-login guidance error when stored extras are incomplete", async () => {
		const credential = { type: "oauth" as const, access: "x", refresh: "r", expires: 0 }
		await expect(refreshCastAiOauth(credential, new AbortController().signal)).rejects.toThrow(/sign in again/)
	})
})
