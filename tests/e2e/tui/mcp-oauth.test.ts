import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, runRestartableMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { MCP_FIXTURE_OAUTH_ACCESS_TOKEN, mcpToolResult, oauthBrowserDriverScript } from "./support/mcp-fixture.js"
import { gatewayMcpCall, modelReply, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

test("migrates legacy plaintext OAuth credentials before the first connection", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: "legacy-oauth-migration" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-legacy-migration",
			mcp: {
				transport: "oauth",
				oauthPreauthorized: true,
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: legacy-oauth-migration" }] },
							{ message: "legacy-oauth-migration" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("The migrated OAuth credential worked without logging in again.")],
			seedHome(homeDir) {
				const agentDir = join(homeDir, ".config", "kimchi", "harness")
				const config = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")) as {
					mcpServers?: { fixture?: { url?: unknown } }
				}
				const serverUrl = config.mcpServers?.fixture?.url
				if (typeof serverUrl !== "string") throw new Error("OAuth fixture config is missing its URL")
				const legacyPath = join(agentDir, "mcp-oauth", "fixture", "tokens.json")
				mkdirSync(dirname(legacyPath), { recursive: true })
				writeFileSync(
					legacyPath,
					JSON.stringify({
						tokens: { accessToken: MCP_FIXTURE_OAUTH_ACCESS_TOKEN, expiresAt: 2_000_000_000 },
						clientInfo: {
							clientId: "kimchi-e2e-oauth-client",
							clientIdIssuedAt: Math.floor(Date.now() / 1_000),
						},
						serverUrl,
					}),
					{ mode: 0o600 },
				)
			},
		},
		async (fixture, trace) => {
			await fixture.mcp.waitForEvent("http_session_initialized", {
				description: "MCP connection using migrated OAuth credentials",
			})
			const legacyPath = join(fixture.agentDir, "mcp-oauth", "fixture", "tokens.json")
			expect(existsSync(legacyPath)).toBe(true)
			expect(existsSync(join(dirname(legacyPath), ".pi-mcp-adapter-migrated"))).toBe(true)
			const keyringDir = join(fixture.agentDir, "mcp-keyring")
			const keyringPayloads = readdirSync(keyringDir).map((name) => readFileSync(join(keyringDir, name), "utf8"))
			expect(keyringPayloads.some((payload) => payload.includes(MCP_FIXTURE_OAUTH_ACCESS_TOKEN))).toBe(true)

			terminal.submit("Call MCP using the credential stored by the previous Kimchi adapter")
			await waitForText(terminal, "The migrated OAuth credential worked without logging in again.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "legacy-oauth-migration" } },
			})

			expect(fixture.mcp.hasEvent("oauth_browser_opened")).toBe(false)
			expect(fixture.mcp.hasEvent("oauth_token_issued")).toBe(false)
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: legacy-oauth-migration")
			trace.step("legacy plaintext credentials moved into and loaded from the upstream secure store")
		},
	)
})

test("logs into an HTTP MCP server with OAuth authorization code and PKCE", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: "oauth-login" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-login",
			mcp: {
				transport: "oauth",
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-login" }] },
							{ message: "oauth-login" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("The OAuth-authenticated MCP tool returned successfully.")],
		},
		async (fixture, trace) => {
			await fixture.mcp.waitForEvent("http_unauthorized", {
				description: "initial OAuth challenge",
			})
			trace.step("protected MCP endpoint challenged the unauthenticated client")

			terminal.submit("/mcp-auth fixture")
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
				description: "OAuth token exchange with verified PKCE",
			})
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("browser redirect, callback, and authorization-code exchange completed")

			terminal.submit("Call the OAuth-protected MCP echo tool")
			await waitForText(terminal, "The OAuth-authenticated MCP tool returned successfully.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-login" } },
			})

			expect(fixture.mcp.hasEvent("oauth_resource_metadata_requested")).toBe(true)
			expect(fixture.mcp.hasEvent("oauth_server_metadata_requested")).toBe(true)
			// Dynamic registration keeps the upstream loopback-IP default; only
			// fixed-client servers switch to the localhost callback.
			const dcr = await fixture.mcp.waitForEvent("oauth_client_registered", {
				description: "dynamic client registration used the default loopback redirect URI",
			})
			expect(dcr.redirectUris).toEqual(["http://127.0.0.1:19876/callback"])
			// Offline access is only requested from Google's authorization endpoint.
			const authorized = await fixture.mcp.waitForEvent("oauth_authorized", {
				description: "authorization request to a non-Google server",
			})
			expect(authorized.accessType).toBeUndefined()
			expect(authorized.prompt).toBeUndefined()
			expect(fixture.mcp.hasEvent("oauth_browser_opened")).toBe(true)
			expect(fixture.mcp.hasEvent("oauth_browser_completed")).toBe(true)
			expect(fixture.mcp.hasEvent("http_request", { authorized: true })).toBe(true)
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: oauth-login")
			trace.step("authenticated MCP call and every OAuth protocol boundary verified")
		},
	)
})

/** Replace the auto-completing browser driver with a record-only one: it logs the authorize URL and never fetches it. */
function useRecordOnlyBrowser(homeDir: string): void {
	const agentDir = join(homeDir, ".config", "kimchi", "harness")
	const browserPath = join(agentDir, "mcp-oauth-browser", "open")
	const eventPath = join(agentDir, "mcp-fixture-fixture.jsonl")
	writeFileSync(browserPath, oauthBrowserDriverScript(eventPath, { autoComplete: false }), "utf8")
	chmodSync(browserPath, 0o755)
}

test("requests offline access from Google's authorization endpoint", async ({ terminal }) => {
	// Google only issues a refresh token for access_type=offline (and re-issues one to
	// an already-consented user only with prompt=consent). The fixture advertises
	// Google's endpoint; the browser driver records the URL without fetching it.
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-google-offline",
			mcp: { transport: "oauth", scenario: "oauth-google-authorization-endpoint" },
			responses: [],
			seedHome: useRecordOnlyBrowser,
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			const opened = await fixture.mcp.waitForEvent("oauth_browser_opened", {
				description: "recorded authorize URL for Google's endpoint",
			})
			const target = new URL(opened.target)
			expect(target.origin + target.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
			expect(target.searchParams.get("access_type")).toBe("offline")
			expect(target.searchParams.get("prompt")).toBe("consent")
			trace.step("Google authorize URL carries access_type=offline and prompt=consent")
		},
	)
})

test("user-supplied authorizationParams win over the Google offline-access defaults", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-google-user-params",
			mcp: {
				transport: "oauth",
				scenario: "oauth-google-authorization-endpoint",
				oauth: { scope: "mcp:tools", authorizationParams: { access_type: "online" } },
			},
			responses: [],
			seedHome: useRecordOnlyBrowser,
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			const opened = await fixture.mcp.waitForEvent("oauth_browser_opened", {
				description: "recorded authorize URL for Google's endpoint",
			})
			const target = new URL(opened.target)
			expect(target.searchParams.get("access_type")).toBe("online")
			expect(target.searchParams.get("prompt")).toBe("consent")
			trace.step("configured access_type kept; unset prompt still defaults to consent")
		},
	)
})

test("appends the advertised offline_access scope to a configured scope", async ({ terminal }) => {
	// OIDC providers (Microsoft, Okta, ...) advertise offline_access in scopes_supported;
	// the client must request that scope, not a vendor parameter.
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-offline-scope",
			mcp: { transport: "oauth", scenario: "oauth-offline-access-scope", oauth: { scope: "mcp:tools" } },
			responses: [],
			seedHome: useRecordOnlyBrowser,
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			const opened = await fixture.mcp.waitForEvent("oauth_browser_opened", {
				description: "recorded authorize URL for the scope-advertising fixture",
			})
			const target = new URL(opened.target)
			expect(target.searchParams.get("scope")).toBe("mcp:tools offline_access")
			expect(target.searchParams.get("access_type")).toBeNull()
			trace.step("authorize URL scope carries the advertised offline_access and no vendor parameters")
		},
	)
})

test("passes user-supplied authorizationParams through to the authorization request", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-authorization-params",
			mcp: {
				transport: "oauth",
				oauth: { scope: "mcp:tools", authorizationParams: { access_type: "online", prompt: "login" } },
			},
			responses: [modelReply("unused")],
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			const authorized = await fixture.mcp.waitForEvent("oauth_authorized", {
				description: "authorization request carried the configured params",
			})
			expect(authorized.accessType).toBe("online")
			expect(authorized.prompt).toBe("login")
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("configured authorizationParams reached the authorization endpoint unchanged")
		},
	)
})

test("completes a pre-registered https redirect OAuth flow through the loopback callback", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: "oauth-remote-redirect" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-remote-redirect",
			mcp: {
				transport: "oauth",
				oauth: { redirectUri: "https://app.kimchi.dev/mcp-oauth/callback-v2" },
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-remote-redirect" }] },
							{ message: "oauth-remote-redirect" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("The remote redirect OAuth flow completed without pasting a URL.")],
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			await fixture.mcp.waitForEvent("oauth_authorized", {
				where: { redirectUri: "https://app.kimchi.dev/mcp-oauth/callback-v2" },
				description: "authorization issued for the pre-registered https redirect URI",
			})
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
				description: "token exchange completed after the loopback callback, not a pasted URL",
			})
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("https redirect flow completed through the local callback server without manual paste")

			const registered = await fixture.mcp.waitForEvent("oauth_client_registered", {
				description: "dynamic client registration carried the https redirect URI",
			})
			expect(registered.redirectUris).toEqual(["https://app.kimchi.dev/mcp-oauth/callback-v2"])
			const browserCompleted = await fixture.mcp.waitForEvent("oauth_browser_completed", {
				description: "fixture browser followed the bounced redirect to the loopback callback",
			})
			expect(browserCompleted.status).toBe(200)

			terminal.submit("Call the OAuth-protected MCP echo tool")
			await waitForText(terminal, "The remote redirect OAuth flow completed without pasting a URL.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-remote-redirect" } },
			})
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: oauth-remote-redirect")
			trace.step("authenticated MCP call after remote redirect flow verified")
		},
	)
})

test("re-auth of a pre-registered client reuses the stored redirect URI", async ({ terminal }) => {
	// A client registered with the pre-1.3.0 default (http://localhost:19876/callback)
	// must receive that exact URI on re-auth; sending the new 127.0.0.1 default
	// makes strict servers (e.g. Google) reject the flow with redirect_uri_mismatch.
	const echo = gatewayMcpCall("echo", { message: "oauth-stored-redirect" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-stored-redirect",
			mcp: {
				transport: "oauth",
				scenario: "oauth-pre-registered",
				oauth: { clientId: "kimchi-e2e-pre-registered-client" },
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-stored-redirect" }] },
							{ message: "oauth-stored-redirect" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("The re-auth reused the stored redirect URI.")],
			seedHome(homeDir) {
				// Simulate a registration stored by the pre-1.3.0 adapter: a client
				// whose redirect list pins the localhost callback, with no tokens
				// (the user must sign in again). Written straight into the file-backed
				// test keyring the session reads (service remapped by the keyring
				// bridge; account is sha256 of the server name — adapter layout).
				const agentDir = join(homeDir, ".config", "kimchi", "harness")
				const config = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")) as {
					mcpServers?: { fixture?: { url?: unknown } }
				}
				const serverUrl = config.mcpServers?.fixture?.url
				if (typeof serverUrl !== "string") throw new Error("OAuth fixture config is missing its URL")
				const account = `sha256-${createHash("sha256").update("fixture").digest("hex")}`
				const keyringPath = join(
					agentDir,
					"mcp-keyring",
					createHash("sha256").update(`dev.kimchi.mcp.oauth\u0000${account}`).digest("hex"),
				)
				mkdirSync(dirname(keyringPath), { recursive: true })
				writeFileSync(
					keyringPath,
					JSON.stringify({
						clientInfo: {
							clientId: "kimchi-e2e-pre-registered-client",
							clientIdIssuedAt: Math.floor(Date.now() / 1_000),
							redirectUris: ["http://localhost:19876/callback"],
						},
						serverUrl,
					}),
					{ mode: 0o600 },
				)
			},
		},
		async (fixture, trace) => {
			await fixture.mcp.waitForEvent("http_unauthorized", {
				description: "initial OAuth challenge",
			})
			trace.step("protected MCP endpoint challenged the unauthenticated client")

			terminal.submit("/mcp-auth fixture")
			const authorized = await fixture.mcp.waitForEvent("oauth_authorized", {
				description: "authorization request carried the stored localhost redirect URI",
			})
			expect(authorized.redirectUri).toBe("http://localhost:19876/callback")
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
				description: "token exchange completed with the reused redirect URI",
			})
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("re-auth completed against the pre-registered redirect URI")

			expect(fixture.mcp.hasEvent("oauth_client_registered")).toBe(false)
			const browserCompleted = await fixture.mcp.waitForEvent("oauth_browser_completed", {
				description: "browser followed the redirect to the loopback callback",
			})
			expect(browserCompleted.status).toBe(200)

			terminal.submit("Call the OAuth-protected MCP echo tool")
			await waitForText(terminal, "The re-auth reused the stored redirect URI.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-stored-redirect" } },
			})
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: oauth-stored-redirect")
			trace.step("authenticated MCP call after stored-redirect re-auth verified")
		},
	)
})

test("re-auth with a pre-registered client secret reuses the stored redirect URI", async ({ terminal }) => {
	// Mirrors the reported Gmail MCP configuration shape: a fixed clientId AND
	// clientSecret with no explicit redirectUri, plus a stored registration from
	// the pre-1.3.0 adapter pinning the localhost callback. With a client secret
	// the token request uses client_secret_post.
	const echo = gatewayMcpCall("echo", { message: "oauth-stored-redirect-secret" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-stored-redirect-secret",
			mcp: {
				transport: "oauth",
				scenario: "oauth-pre-registered",
				oauth: { clientId: "kimchi-e2e-pre-registered-client", clientSecret: "kimchi-e2e-client-secret" },
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-stored-redirect-secret" }] },
							{ message: "oauth-stored-redirect-secret" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("The secret-bearing re-auth reused the stored redirect URI.")],
			seedHome(homeDir) {
				const agentDir = join(homeDir, ".config", "kimchi", "harness")
				const config = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")) as {
					mcpServers?: { fixture?: { url?: unknown } }
				}
				const serverUrl = config.mcpServers?.fixture?.url
				if (typeof serverUrl !== "string") throw new Error("OAuth fixture config is missing its URL")
				const account = `sha256-${createHash("sha256").update("fixture").digest("hex")}`
				const keyringPath = join(
					agentDir,
					"mcp-keyring",
					createHash("sha256").update(`dev.kimchi.mcp.oauth\u0000${account}`).digest("hex"),
				)
				mkdirSync(dirname(keyringPath), { recursive: true })
				writeFileSync(
					keyringPath,
					JSON.stringify({
						clientInfo: {
							clientId: "kimchi-e2e-pre-registered-client",
							clientSecret: "kimchi-e2e-client-secret",
							clientIdIssuedAt: Math.floor(Date.now() / 1_000),
							redirectUris: ["http://localhost:19876/callback"],
						},
						serverUrl,
					}),
					{ mode: 0o600 },
				)
			},
		},
		async (fixture, trace) => {
			await fixture.mcp.waitForEvent("http_unauthorized", {
				description: "initial OAuth challenge",
			})
			trace.step("protected MCP endpoint challenged the unauthenticated client")

			terminal.submit("/mcp-auth fixture")
			const authorized = await fixture.mcp.waitForEvent("oauth_authorized", {
				description: "authorization request carried the stored localhost redirect URI",
			})
			expect(authorized.redirectUri).toBe("http://localhost:19876/callback")
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
				description: "token exchange completed with the reused redirect URI and client secret",
			})
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("secret-bearing re-auth completed against the pre-registered redirect URI")

			expect(fixture.mcp.hasEvent("oauth_client_registered")).toBe(false)

			terminal.submit("Call the OAuth-protected MCP echo tool")
			await waitForText(terminal, "The secret-bearing re-auth reused the stored redirect URI.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-stored-redirect-secret" } },
			})
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: oauth-stored-redirect-secret")
			trace.step("authenticated MCP call after secret-bearing stored-redirect re-auth verified")
		},
	)
})

test("first auth of a pre-registered client uses the localhost callback", async ({ terminal }) => {
	// Fixed-client registrations (e.g. Google) list the localhost
	// callback only. With no stored registration and no redirectUri in config,
	// the 127.0.0.1 default would be rejected as redirect_uri_mismatch.
	const echo = gatewayMcpCall("echo", { message: "oauth-first-auth-localhost" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-first-auth-localhost",
			mcp: {
				transport: "oauth",
				scenario: "oauth-pre-registered",
				oauth: { clientId: "kimchi-e2e-pre-registered-client" },
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-first-auth-localhost" }] },
							{ message: "oauth-first-auth-localhost" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("The first auth used the localhost callback.")],
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			const authorized = await fixture.mcp.waitForEvent("oauth_authorized", {
				description: "authorization request carried the localhost redirect URI",
			})
			expect(authorized.redirectUri).toBe("http://localhost:19876/callback")
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
				description: "token exchange completed against the localhost redirect URI",
			})
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(fixture.mcp.hasEvent("oauth_client_registered")).toBe(false)
			trace.step("first auth completed against the pre-registered localhost redirect URI")

			terminal.submit("Call the OAuth-protected MCP echo tool")
			await waitForText(terminal, "The first auth used the localhost callback.", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-first-auth-localhost" } },
			})
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: oauth-first-auth-localhost")
		},
	)
})

test("re-auth of a pre-registered client whose stored redirect URIs were dropped uses the localhost callback", async ({
	terminal,
}) => {
	// Registrations rewritten by the unpatched 1.3.0 adapter keep the clientId but
	// lose redirectUris, so there is nothing to reuse and the default must still
	// be the localhost callback.
	const echo = gatewayMcpCall("echo", { message: "oauth-dropped-redirect" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-dropped-redirect",
			mcp: {
				transport: "oauth",
				scenario: "oauth-pre-registered",
				oauth: { clientId: "kimchi-e2e-pre-registered-client" },
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-dropped-redirect" }] },
							{ message: "oauth-dropped-redirect" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("The re-auth fell back to the localhost callback.")],
			seedHome(homeDir) {
				const agentDir = join(homeDir, ".config", "kimchi", "harness")
				const config = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")) as {
					mcpServers?: { fixture?: { url?: unknown } }
				}
				const serverUrl = config.mcpServers?.fixture?.url
				if (typeof serverUrl !== "string") throw new Error("OAuth fixture config is missing its URL")
				const account = `sha256-${createHash("sha256").update("fixture").digest("hex")}`
				const keyringPath = join(
					agentDir,
					"mcp-keyring",
					createHash("sha256").update(`dev.kimchi.mcp.oauth\u0000${account}`).digest("hex"),
				)
				mkdirSync(dirname(keyringPath), { recursive: true })
				writeFileSync(
					keyringPath,
					JSON.stringify({
						clientInfo: {
							clientId: "kimchi-e2e-pre-registered-client",
							clientIdIssuedAt: Math.floor(Date.now() / 1_000),
						},
						serverUrl,
					}),
					{ mode: 0o600 },
				)
			},
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			const authorized = await fixture.mcp.waitForEvent("oauth_authorized", {
				description: "authorization request carried the localhost redirect URI",
			})
			expect(authorized.redirectUri).toBe("http://localhost:19876/callback")
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
				description: "token exchange completed against the localhost redirect URI",
			})
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(fixture.mcp.hasEvent("oauth_client_registered")).toBe(false)
			trace.step("re-auth completed after the stored redirect URIs were dropped")

			terminal.submit("Call the OAuth-protected MCP echo tool")
			await waitForText(terminal, "The re-auth fell back to the localhost callback.", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-dropped-redirect" } },
			})
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: oauth-dropped-redirect")
		},
	)
})

test("automatically authenticates and retries an OAuth-protected MCP call", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: "oauth-auto-auth" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-auto-auth",
			mcp: {
				transport: "oauth",
				autoAuth: true,
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-auto-auth" }] },
							{ message: "oauth-auto-auth" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("Automatic MCP OAuth completed without a slash command.")],
		},
		async (fixture, trace) => {
			terminal.submit("Call the protected MCP tool and authenticate automatically")
			await waitForText(terminal, "Automatic MCP OAuth completed without a slash command.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-auto-auth" } },
			})
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: oauth-auto-auth")
			trace.step("gateway call initiated OAuth, retried, and returned the protected tool result")
		},
	)
})

test("authenticates a non-interactive MCP server with client credentials", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: "oauth-client-credentials" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-client-credentials",
			mcp: {
				transport: "oauth",
				autoAuth: true,
				oauth: {
					grantType: "client_credentials",
					clientId: "kimchi-e2e-client",
					clientSecret: "kimchi-e2e-client-secret",
					scope: "mcp:tools",
				},
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-client-credentials" }] },
							{ message: "oauth-client-credentials" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("MCP client credentials authenticated without a browser.")],
		},
		async (fixture, trace) => {
			terminal.submit("Call the machine-authenticated MCP tool")
			await waitForText(terminal, "MCP client credentials authenticated without a browser.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "client_credentials" },
			})
			expect(fixture.mcp.hasEvent("oauth_browser_opened")).toBe(false)
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-client-credentials" } },
			})
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: oauth-client-credentials")
			trace.step("client-credentials token exchange and protected call completed without browser interaction")
		},
	)
})

test("returns an OAuth denial to the TUI and keeps the Kimchi session usable", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-denial",
			mcp: { transport: "oauth", scenario: "oauth-deny" },
			responses: [modelReply("The session stayed usable after OAuth was denied.")],
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			await waitForText(terminal, 'Failed to authenticate "fixture": fixture authorization denied', {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("oauth_authorization_denied")
			expect(fixture.mcp.hasEvent("oauth_token_issued")).toBe(false)
			expect(fixture.mcp.hasEvent("oauth_browser_completed")).toBe(true)
			trace.step("authorization denial returned through the callback without storing a token")

			terminal.submit("Continue with a normal response after the denied login")
			await waitForText(terminal, "The session stayed usable after OAuth was denied.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("main session remained usable after OAuth denial")
		},
	)
})

test("reports a failed OAuth token exchange without persisting partial authentication", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-token-failure",
			mcp: { transport: "oauth", scenario: "oauth-token-failure" },
			responses: [],
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			await waitForText(terminal, 'Failed to authenticate "fixture"', { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("oauth_token_rejected")
			expect(fixture.mcp.hasEvent("oauth_token_issued")).toBe(false)
			trace.step("token endpoint failure settled and no access token was issued")
		},
	)
})

test("refreshes an expired MCP OAuth token after a real Kimchi process restart", async ({ terminal }) => {
	const beforeRestart = gatewayMcpCall("echo", { message: "before-oauth-restart" })
	const afterRestart = gatewayMcpCall("echo", { message: "after-oauth-refresh" })
	await runRestartableMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-refresh-restart",
			mcp: {
				transport: "oauth",
				scenario: "oauth-expiring",
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: before-oauth-restart" }] },
							{ message: "before-oauth-restart" },
						),
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: after-oauth-refresh" }] },
							{ message: "after-oauth-refresh" },
						),
					],
				},
			},
			responses: [
				beforeRestart.response,
				modelReply("The first OAuth MCP call succeeded."),
				afterRestart.response,
				modelReply("The refreshed OAuth MCP call succeeded after restart."),
			],
		},
		async (fixture, session, trace) => {
			terminal.submit("/mcp-auth fixture")
			const initialToken = await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
			})
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			await session.turn("Call MCP before restarting", "The first OAuth MCP call succeeded.")
			expect(toolResultText(fixture.fake.requests, beforeRestart)).toContain("fixture echo: before-oauth-restart")
			await fixture.mcp.waitForOAuthTokenExpiry(initialToken)

			await session.restart()
			trace.step("expired OAuth credentials persisted across a verified process restart")
			await session.turn(
				"Call MCP using the persisted token after restarting",
				"The refreshed OAuth MCP call succeeded after restart.",
			)

			const refresh = await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "refresh_token" },
				description: "OAuth refresh-token exchange after restart",
			})
			expect(refresh.grantType).toBe("refresh_token")
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "after-oauth-refresh" } },
			})
			expect(toolResultText(fixture.fake.requests, afterRestart)).toContain("fixture echo: after-oauth-refresh")
		},
	)
})

test("replays the success page for a completed OAuth state and serves an error page for unknown states", async ({
	terminal,
}) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-completed-state-replay",
			mcp: { transport: "oauth" },
			responses: [],
			seedHome(homeDir) {
				const agentDir = join(homeDir, ".config", "kimchi", "harness")

				// Replace the auto-completing browser driver with a record-only
				// variant: it logs each opened authorize URL and never fetches it,
				// so the second flow stays pending and keeps the loopback listener
				// alive.
				const browserPath = join(agentDir, "mcp-oauth-browser", "open")
				const eventPath = join(agentDir, "mcp-fixture-fixture.jsonl")
				writeFileSync(browserPath, oauthBrowserDriverScript(eventPath, { autoComplete: false }), "utf8")
				chmodSync(browserPath, 0o755)
			},
		},
		async (fixture, trace) => {
			// The TUI serializes auth flows: while flow A is pending, a second
			// /mcp-auth never opens a browser. So record flow A's authorize URL,
			// complete flow A first, and only then start flow B.
			terminal.submit("/mcp-auth fixture")
			const openedA = await fixture.mcp.waitForEvent("oauth_browser_opened", {
				description: "recorded browser open for the first OAuth flow",
			})

			// Complete flow A the way the real driver would: follow the authorize
			// redirect chain until it lands on the loopback callback.
			const completed = await fetch(openedA.target, { redirect: "follow" })
			const completedHtml = await completed.text()
			expect(completed.status).toBe(200)
			expect(completedHtml).toContain("<title>MCP Authorization Successful</title>")
			expect(completedHtml).toContain("You can close this window and return to Kimchi.")
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
				description: "token exchange for the manually completed flow",
			})
			const callbackUrl = completed.url
			trace.step("manually completed the first flow through its loopback callback")

			// Clear flow A's stored credentials: with credentials present, the next
			// /mcp-auth takes the refresh-token path and never opens a browser.
			// Logging out forces flow B into a fresh authorization-code flow.
			terminal.submit("/mcp logout fixture")
			await waitForText(terminal, 'OAuth credentials cleared for "fixture"', {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("logged out of the fixture so flow B starts a fresh authorization-code flow")

			// Start flow B now that flow A is done and logged out. Both flows run
			// in the TUI process, so flow B's pending state restarts the loopback
			// listener in the same module instance that holds flow A's completion
			// tombstone.
			terminal.submit("/mcp-auth fixture")
			const openedB = await fixture.mcp.waitForEvent("oauth_browser_opened", {
				predicate: (event) => event.target !== openedA.target,
				description: "recorded browser open for the second OAuth flow",
			})
			trace.step("second OAuth flow recorded its authorize URL without auto-completing")

			// The listener binds an ephemeral port per flow: after flow A completed
			// and its listener closed, flow B's start bound a NEW port, so A's
			// recorded callback URL points at a dead port. Tombstones are
			// process-global though — any live listener serves them — so replay
			// A's state against the CURRENTLY live listener (flow B's, whose
			// authorize URL embeds its redirect_uri).
			const stateA = new URL(callbackUrl).searchParams.get("state")
			if (!stateA) throw new Error("completed callback URL is missing its state parameter")
			const bRedirectUri = new URL(openedB.target).searchParams.get("redirect_uri")
			if (!bRedirectUri) throw new Error("second authorize URL is missing its redirect_uri parameter")
			const listenerOrigin = new URL(bRedirectUri).origin

			// Replaying a completed state must replay the success page:
			// the state carries a completion tombstone, and flow B still being
			// pending keeps the loopback listener alive.
			const replay = await fetch(`${listenerOrigin}/callback?code=replayed&state=${encodeURIComponent(stateA)}`)
			const replayHtml = await replay.text()
			expect(replay.status).toBe(200)
			expect(replayHtml).toContain("<title>MCP Authorization Successful</title>")
			expect(replayHtml).toContain("You can close this window and return to Kimchi.")
			trace.step("replayed callback URL returned the success page for the completed state")

			// A state belonging to no flow and carrying no tombstone gets the
			// neutral branded error page with its 400 status preserved.
			const unknown = await fetch(`${listenerOrigin}/callback?code=x&state=bogus-unknown`)
			const unknownHtml = await unknown.text()
			expect(unknown.status).toBe(400)
			expect(unknownHtml).toContain("MCP Authorization No Longer Active")
			expect(unknownHtml).toContain("This authorization link is no longer valid.")
			expect(unknownHtml).not.toContain("CSRF")
			expect(unknownHtml).not.toContain("MCP Authorization Successful")
			trace.step("unknown OAuth state received the branded inactive error page")
		},
	)
})
