import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { dirname, resolve } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * CAST AI SSO: /login offers "Sign in with CAST AI (SSO)" and
 * completes the full OAuth Authorization Code + PKCE round trip against a
 * local mock Auth0 tenant — the "browser" is a deterministic driver script
 * ($BROWSER) that records the authorize URL and follows it, so the mock AS
 * redirects to the harness's loopback callback and the code is exchanged for
 * tokens with a refresh grant available.
 */

interface TokenGrant {
	grantType: string
	refreshToken?: string
}

interface MockAuthServer {
	authorizeUrl: string
	tokenUrl: string
	organizationsUrl: string
	grants: TokenGrant[]
	orgRequests: Array<{ authorization: string | null }>
	close(): Promise<void>
}

/** Mock Auth0 tenant + Cast AI users API: /authorize auto-approves (302 to
 * the loopback callback with a fresh code + the echoed state), /token answers
 * authorization_code and refresh_token grants, and GET /v1/organizations
 * lists the account's organizations. Mirrors the kubecast mock-oauth test
 * stub pattern from the tilt harness. */
async function startMockAuthServer(): Promise<MockAuthServer> {
	const grants: TokenGrant[] = []
	const orgRequests: Array<{ authorization: string | null }> = []
	const organizations = [
		{ id: "org-alpha", name: "Alpha Org" },
		{ id: "org-beta", name: "Beta Org" },
	]
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://127.0.0.1`)
		if (req.method === "GET" && url.pathname === "/v1/organizations") {
			orgRequests.push({ authorization: req.headers.authorization ?? null })
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ organizations }))
			return
		}
		if (req.method === "GET" && url.pathname === "/authorize") {
			const redirectUri = url.searchParams.get("redirect_uri")
			const state = url.searchParams.get("state")
			if (!redirectUri || !state || url.searchParams.get("response_type") !== "code") {
				res.writeHead(400).end("missing redirect_uri/state or bad response_type")
				return
			}
			const target = new URL(redirectUri)
			target.searchParams.set("code", "mock-auth-code-1")
			target.searchParams.set("state", state)
			res.writeHead(302, { location: target.toString() }).end()
			return
		}
		if (req.method === "POST" && url.pathname === "/token") {
			let body = ""
			req.setEncoding("utf-8")
			req.on("data", (chunk: string) => {
				body += chunk
			})
			req.on("end", () => {
				const params = new URLSearchParams(body)
				grants.push({
					grantType: params.get("grant_type") ?? "",
					refreshToken: params.get("refresh_token") ?? undefined,
				})
				if (params.get("grant_type") !== "authorization_code" && params.get("grant_type") !== "refresh_token") {
					res.writeHead(400, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: "unsupported_grant_type" }))
					return
				}
				res.writeHead(200, { "content-type": "application/json" })
				res.end(
					JSON.stringify({
						access_token: "mock-access-token-1",
						id_token: "mock-id-token-1",
						refresh_token: "mock-refresh-token-1",
						expires_in: 3600,
						token_type: "Bearer",
					}),
				)
			})
			return
		}
		res.writeHead(404).end()
	})
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen)
		server.listen(0, "127.0.0.1", () => resolveListen())
	})
	const { port } = server.address() as AddressInfo
	return {
		authorizeUrl: `http://127.0.0.1:${port}/authorize`,
		tokenUrl: `http://127.0.0.1:${port}/token`,
		organizationsUrl: `http://127.0.0.1:${port}/v1/organizations`,
		grants,
		orgRequests,
		close: () =>
			new Promise<void>((done) => {
				server.closeAllConnections?.()
				server.close(() => done())
			}),
	}
}

/** Deterministic "browser": records the authorize URL and completes the flow by
 * fetching it (the mock AS 302s to the harness's loopback callback). */
function browserDriverScript(eventPath: string): string {
	return `#!/usr/bin/env node
import { appendFileSync } from "node:fs"
const target = process.argv.find((argument) => argument.startsWith("http://") || argument.startsWith("https://"))
if (!target) throw new Error("SSO browser driver did not receive an HTTP URL")
appendFileSync(${JSON.stringify(eventPath)}, target + "\\n")
const response = await fetch(target, { redirect: "follow" })
if (!response.ok) throw new Error(\`SSO browser driver received HTTP \${response.status}\`)
`
}

interface BrowserEvent {
	url: string
	openedAt: number
}

async function waitForBrowserEvent(eventPath: string): Promise<BrowserEvent> {
	const deadline = Date.now() + STREAM_TIMEOUT_MS
	for (;;) {
		try {
			const first = readFileSync(eventPath, "utf-8")
				.split("\n")
				.find((line) => line.trim() !== "")
			if (first !== undefined) return { url: first, openedAt: Date.now() }
		} catch {
			// not written yet
		}
		if (Date.now() > deadline) throw new Error("Timed out waiting for the SSO browser driver to open the authorize URL")
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
}

test("login via CAST AI SSO completes the OAuth code exchange and stores a refreshable credential", async ({
	terminal,
}) => {
	const mockAs = await startMockAuthServer()
	try {
		await runKimchiSession(
			terminal,
			{
				artifactName: "login-sso",
				responses: [],
				seedHome: (homeDir) => {
					// Deterministic browser driver: record + auto-complete the authorize URL.
					const browserBinDir = resolve(dirname(homeDir), "sso-browser")
					const browserPath = resolve(browserBinDir, "open")
					const eventPath = resolve(browserBinDir, "events.log")
					mkdirSync(browserBinDir, { recursive: true })
					writeFileSync(browserPath, browserDriverScript(eventPath), "utf-8")
					chmodSync(browserPath, 0o755)
					return {
						env: {
							KIMCHI_OAUTH_AUTHORIZE_URL: mockAs.authorizeUrl,
							KIMCHI_OAUTH_TOKEN_URL: mockAs.tokenUrl,
							KIMCHI_ORGANIZATIONS_URL: mockAs.organizationsUrl,
							BROWSER: browserPath,
							// Route the opener through $BROWSER deterministically
							// (same neutralization the MCP OAuth e2e uses).
							DISPLAY: "",
							WAYLAND_DISPLAY: "",
							XDG_CURRENT_DESKTOP: "X-Generic",
							PATH: `${browserBinDir}:${process.env.PATH ?? ""}`,
						},
					}
				},
			},
			async (fixture, trace) => {
				terminal.write("/login")
				await waitForText(terminal, "/login", { timeoutMs: INPUT_TIMEOUT_MS })
				terminal.submit("")
				await waitForText(terminal, "Sign in with CAST AI (SSO)", { timeoutMs: INPUT_TIMEOUT_MS })
				// SSO is now the recommended first option (no keyDown offset).
				terminal.submit("")
				trace.step("SSO selected in the auth-method selector")

				// Region selector with the current region (US) first.
				await waitForText(terminal, "Select region:", { timeoutMs: INPUT_TIMEOUT_MS })
				terminal.submit("")
				trace.step("region selector confirmed (US)")

				// The login dialog opens and "opens the browser"; the driver
				// completes the authorize → callback → code exchange round trip.
				const browser = await waitForBrowserEvent(resolve(dirname(fixture.homeDir), "sso-browser", "events.log"))
				expect(browser.url).toContain("/authorize?")
				expect(browser.url).toContain("response_type=code")
				expect(browser.url).toContain("code_challenge_method=S256")
				expect(browser.url).toContain("offline_access")
				trace.step("authorize URL built with PKCE + offline_access")

				// The account has two organizations: the login dialog asks for one.
				await waitForText(terminal, "Select organization:", { timeoutMs: STREAM_TIMEOUT_MS })
				await waitForText(terminal, "Alpha Org", { timeoutMs: INPUT_TIMEOUT_MS })
				await waitForText(terminal, "Beta Org", { timeoutMs: INPUT_TIMEOUT_MS })
				trace.step("organization selector visible")
				terminal.keyDown(1)
				terminal.submit("")
				trace.step("organization selected (Beta Org)")

				await waitForText(terminal, "Logged in to Kimchi.", { timeoutMs: STREAM_TIMEOUT_MS, full: true })
				trace.step("login completed")

				// The credential is a real OAuth one with a refresh token and the
				// selected organization, fanned out to the base provider.
				const auth = JSON.parse(
					readFileSync(resolve(fixture.homeDir, ".config", "kimchi", "harness", "auth.json"), "utf-8"),
				) as Record<string, { type?: string; refresh?: string; access?: string; orgId?: string }>
				expect(auth["kimchi-dev"]?.type).toBe("oauth")
				expect(auth["kimchi-dev"]?.refresh).toBe("mock-refresh-token-1")
				expect(auth["kimchi-dev"]?.access).toBe("mock-id-token-1") // the ID token as bearer (default)
				expect(auth["kimchi-dev"]?.orgId).toBe("org-beta")
				trace.step("auth.json stores the OAuth credential with the selected org")

				// The org listing was fetched with the SSO bearer token.
				expect(mockAs.orgRequests).toEqual([{ authorization: "Bearer mock-id-token-1" }])

				// Every Kimchi provider entry in models.json carries the org header.
				const modelsJson = JSON.parse(
					readFileSync(resolve(fixture.homeDir, ".config", "kimchi", "harness", "models.json"), "utf-8"),
				) as { providers?: Record<string, { headers?: Record<string, string> }> }
				for (const [providerId, provider] of Object.entries(modelsJson.providers ?? {})) {
					if (!providerId.startsWith("kimchi")) continue
					const orgHeader = provider.headers?.["X-CastAi-Organization-Id"]
					expect(`${providerId}: ${orgHeader ?? "<missing>"}`).toBe(`${providerId}: org-beta`)
				}
				trace.step("models.json carries X-CastAi-Organization-Id on Kimchi providers")

				// Exactly one authorization_code grant was made (no refresh yet).
				expect(mockAs.grants).toEqual([{ grantType: "authorization_code", refreshToken: undefined }])

				// The region the credential was issued for is persisted and the
				// stale API key from before the SSO login is gone.
				const config = JSON.parse(
					readFileSync(resolve(fixture.homeDir, ".config", "kimchi", "config.json"), "utf-8"),
				) as { region?: string; apiKey?: string }
				expect(config.region).toBe("us")
				expect(config.apiKey ?? "").toBe("")
				trace.step("config.json region persisted, stale key cleared")

				await waitForText(terminal, PROMPT_READY, { timeoutMs: STREAM_TIMEOUT_MS })
				// NOTE: the SSH/headless manual paste-back path is covered by the
				// oauth.test.ts unit suite ("completes via the manual paste-back");
				// its dialog copy is transient here — the dialog is replaced by the
				// editor once the login completes, so it cannot be asserted on the
				// final terminal buffer.
			},
		)
	} finally {
		await mockAs.close()
	}
})
