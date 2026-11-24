import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearApiKey, writeApiKey } from "../../../config.js"
import {
	isCredentialStale,
	markCredentialStale,
	resetCredentialStalenessForTests,
} from "../../../credential-staleness.js"
import { KIMCHI_PROVIDER_ID } from "../../../kimchi-provider.js"
import { type AuthStatusPaths, type AuthStatusResponse, handleAuthStatus } from "./auth-status.js"
import { fakeOAuthDeps } from "./oauth-test-utils.js"

type TokenResponder = (params: URLSearchParams) => { status: number; body: Record<string, unknown> } | undefined

const itStorePermissions = process.platform === "win32" || process.geteuid?.() === 0 ? it.skip : it

// Integration-style handler tests against the real credential store:
// config.json (API key) and auth.json (OAuth credentials) on real temp
// files — no config.js mocks — so the persist→read linkage is exercised.
describe("handleAuthStatus", () => {
	let dir: string
	let configPath: string
	let paths: AuthStatusPaths
	let tokenServer: ReturnType<typeof createServer> | undefined
	let tokenRequests: URLSearchParams[]

	beforeEach(() => {
		tokenServer = undefined
		tokenRequests = []
		vi.stubEnv("KIMCHI_API_KEY", undefined)
		dir = mkdtempSync(join(tmpdir(), "kimchi-auth-status-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", dir)
		resetCredentialStalenessForTests()
		configPath = join(dir, "config.json")
		paths = {
			authPath: join(dir, "auth.json"),
			modelsPath: join(dir, "models.json"),
			configPath,
		}
	})

	afterEach(async () => {
		if (tokenServer) {
			tokenServer.closeAllConnections()
			await new Promise<void>((resolve) => tokenServer?.close(() => resolve()))
		}
		chmodSync(dir, 0o700)
		if (existsSync(paths.authPath)) chmodSync(paths.authPath, 0o600)
		resetCredentialStalenessForTests()
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
		rmSync(dir, { recursive: true, force: true })
	})

	it("reports unauthenticated when neither store holds credentials", async () => {
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: false })
	})

	it("reports authenticated when config.json holds an API key without resolving OAuth", async () => {
		writeApiKey("castai_v1_token", configPath)
		writeOAuthCredential("expiring-token", { expires: Date.now() + 60_000 })
		const deps = fakeOAuthDeps()
		await expect(handleAuthStatus(paths, deps)).resolves.toEqual({ authenticated: true })
		expect(deps.refreshCalls).toHaveLength(0)
	})

	it("keeps an observed API-key rejection after a process restart", async () => {
		writeApiKey("castai_v1_dead", configPath)
		markCredentialStale("castai_v1_dead", "kimchi-dev")
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: false })

		await expect(authStatusInNewProcess(paths)).resolves.toEqual({ authenticated: false })
	})

	it("reports the environment override as authenticated without a saved login", async () => {
		vi.stubEnv("KIMCHI_API_KEY", "environment-key")
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: true })
	})

	it("reports unauthenticated again after the API key is cleared", async () => {
		writeApiKey("castai_v1_token", configPath)
		clearApiKey(configPath)
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: false })
	})

	// Regression: the subscription OAuth login persists credentials only to
	// auth.json — it never writes config.json's apiKey — so an auth check
	// that reads only the config file reports authenticated: false for a
	// logged-in user. Seed the canonical OAuth credential shape
	// ({ type: "oauth", access, refresh, expires }) — malformed entries are
	// dropped by the credential reader.
	it("reports authenticated when only auth.json holds OAuth credentials", async () => {
		writeOAuthCredential("token")
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: true })
	})

	it("refreshes an expiring OAuth credential once and persists it before reporting authenticated", async () => {
		const tokenUrl = await startTokenEndpoint(() => ({
			status: 200,
			body: { access_token: "refreshed-token", expires_in: 3600 },
		}))
		writeOAuthCredential("expiring-token", {
			expires: Date.now() + 60_000,
			tokenUrl,
			clientId: "fake-client",
			useIdToken: false,
		})

		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: true })
		expect(tokenRequests).toHaveLength(1)
		expect(tokenRequests[0]?.get("grant_type")).toBe("refresh_token")
		expect(tokenRequests[0]?.get("refresh_token")).toBe("refresh")
		expect(tokenRequests[0]?.get("client_id")).toBe("fake-client")
		const persisted = JSON.parse(readFileSync(paths.authPath, "utf-8")) as Record<string, Record<string, unknown>>
		expect(persisted[KIMCHI_PROVIDER_ID]).toMatchObject({ access: "refreshed-token", refresh: "refresh" })
		expect(persisted[KIMCHI_PROVIDER_ID]?.expires).toBeGreaterThan(Date.now() + 50 * 60_000)
	})

	it("recovers an expiring OAuth credential after a provider-wide 401 mark", async () => {
		const tokenUrl = await startTokenEndpoint(() => ({
			status: 200,
			body: { access_token: "refreshed-access", expires_in: 3600 },
		}))
		writeOAuthCredential("expiring-access", {
			expires: Date.now() + 60_000,
			tokenUrl,
			clientId: "fake-client",
			useIdToken: false,
		})
		markCredentialStale(undefined, KIMCHI_PROVIDER_ID)
		markCredentialStale("expiring-access", KIMCHI_PROVIDER_ID)
		markCredentialStale("unrelated-api-key", KIMCHI_PROVIDER_ID)

		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: true })

		expect(tokenRequests).toHaveLength(1)
		const persisted = JSON.parse(readFileSync(paths.authPath, "utf-8")) as Record<string, Record<string, unknown>>
		expect(persisted[KIMCHI_PROVIDER_ID]?.access).toBe("refreshed-access")
		expect(isCredentialStale(undefined, KIMCHI_PROVIDER_ID)).toBe(false)
		expect(isCredentialStale("expiring-access", KIMCHI_PROVIDER_ID)).toBe(false)
		expect(isCredentialStale("refreshed-access", KIMCHI_PROVIDER_ID)).toBe(false)
		expect(isCredentialStale("unrelated-api-key", KIMCHI_PROVIDER_ID)).toBe(true)
	})

	it("clears a provider-wide 401 mark that arrives during a successful refresh", async () => {
		writeOAuthCredential("expiring-access", { expires: Date.now() + 60_000 })
		const deps = fakeOAuthDeps((credential) => {
			markCredentialStale(undefined, KIMCHI_PROVIDER_ID)
			return { ...credential, access: "refreshed-access", expires: Date.now() + 3600_000 }
		})

		await expect(handleAuthStatus(paths, deps)).resolves.toEqual({ authenticated: true })

		expect(deps.refreshCalls).toHaveLength(1)
		expect(isCredentialStale(undefined, KIMCHI_PROVIDER_ID)).toBe(false)
		const persisted = JSON.parse(readFileSync(paths.authPath, "utf-8")) as Record<string, Record<string, unknown>>
		expect(persisted[KIMCHI_PROVIDER_ID]?.access).toBe("refreshed-access")
	})

	it("does not refresh an OAuth credential outside the five-minute window", async () => {
		writeOAuthCredential("fresh-token")
		const deps = fakeOAuthDeps()
		await expect(handleAuthStatus(paths, deps)).resolves.toEqual({ authenticated: true })
		expect(deps.refreshCalls).toHaveLength(0)
	})

	it("reports unauthenticated when the issuer definitively rejects the refresh grant", async () => {
		const tokenUrl = await startTokenEndpoint(() => ({
			status: 400,
			body: { error: "invalid_grant", error_description: "refresh token revoked" },
		}))
		writeOAuthCredential("revoked-token", {
			expires: Date.now() + 60_000,
			tokenUrl,
			clientId: "fake-client",
			useIdToken: false,
		})

		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: false })
		expect(tokenRequests).toHaveLength(1)
		expect(tokenRequests[0]?.get("grant_type")).toBe("refresh_token")
		expect(isCredentialStale("revoked-token", KIMCHI_PROVIDER_ID)).toBe(true)
	})

	it("rejects rather than signing out when the issuer is unreachable", async () => {
		const tokenUrl = await startUnreachableTokenEndpoint()
		writeOAuthCredential("expiring-token", {
			expires: Date.now() + 60_000,
			tokenUrl,
			clientId: "fake-client",
			useIdToken: false,
		})

		await expect(handleAuthStatus(paths)).rejects.toMatchObject({ code: "oauth" })
		expect(isCredentialStale("expiring-token", KIMCHI_PROVIDER_ID)).toBe(false)
	})

	it("rejects rather than signing out after a real issuer 500 response", async () => {
		const tokenUrl = await startTokenEndpoint(() => ({ status: 500, body: { error: "server_error" } }))
		writeOAuthCredential("expiring-token", {
			expires: Date.now() + 60_000,
			tokenUrl,
			clientId: "fake-client",
			useIdToken: false,
		})

		await expect(handleAuthStatus(paths)).rejects.toMatchObject({ code: "oauth" })
		expect(tokenRequests).toHaveLength(1)
		expect(isCredentialStale("expiring-token", KIMCHI_PROVIDER_ID)).toBe(false)
	})

	it("rejects rather than signing out when the real token request times out", async () => {
		const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {})
		const tokenUrl = await startTokenEndpoint(() => undefined)
		writeOAuthCredential("expiring-token", {
			expires: Date.now() + 60_000,
			tokenUrl,
			clientId: "fake-client",
			useIdToken: false,
		})

		await expect(handleAuthStatus(paths)).rejects.toMatchObject({ code: "oauth" })
		expect(diagnostics).toHaveBeenCalledWith({ event: "kimchi.oauth.refresh", outcome: "failed", category: "timeout" })
		expect(tokenRequests).toHaveLength(1)
		expect(isCredentialStale("expiring-token", KIMCHI_PROVIDER_ID)).toBe(false)
	}, 20_000)

	it("does not treat another credential's stale mark as a transient-refresh sign-out", async () => {
		writeOAuthCredential("current-token", { expires: Date.now() + 60_000 })
		markCredentialStale("previously-rejected-token", KIMCHI_PROVIDER_ID)
		const deps = fakeOAuthDeps(() => {
			throw new Error("offline")
		})

		await expect(handleAuthStatus(paths, deps)).rejects.toMatchObject({ code: "oauth" })
	})

	it("preserves a previously rejected API key across local OAuth resolution", async () => {
		markCredentialStale("previously-rejected-key", KIMCHI_PROVIDER_ID)
		writeOAuthCredential("fresh-oauth-token")
		await expect(handleAuthStatus(paths, fakeOAuthDeps())).resolves.toEqual({ authenticated: true })

		writeApiKey("previously-rejected-key", configPath)
		await expect(handleAuthStatus(paths, fakeOAuthDeps())).resolves.toEqual({ authenticated: false })
	})

	it("reports credential-store read failures instead of credential presence", async () => {
		const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {})
		writeFileSync(paths.authPath, "{corrupt")

		await expect(handleAuthStatus(paths, fakeOAuthDeps())).rejects.toMatchObject({ code: "auth" })
		expect(diagnostics).toHaveBeenCalledWith({ event: "kimchi.oauth.refresh", outcome: "store_failed" })
	})

	itStorePermissions("rejects when a refreshed credential cannot be persisted", async () => {
		writeOAuthCredential("expiring-token", { expires: Date.now() + 60_000 })
		const original = readFileSync(paths.authPath, "utf-8")
		const deps = fakeOAuthDeps((credential) => {
			chmodSync(paths.authPath, 0o400)
			chmodSync(dir, 0o500)
			return { ...credential, access: "must-not-be-used", expires: Date.now() + 3600_000 }
		})

		try {
			await expect(handleAuthStatus(paths, deps)).rejects.toMatchObject({ code: "auth" })
		} finally {
			chmodSync(dir, 0o700)
			chmodSync(paths.authPath, 0o600)
		}
		expect(readFileSync(paths.authPath, "utf-8")).toBe(original)
	})

	it("coalesces concurrent reads into one coherent persisted refresh", async () => {
		writeOAuthCredential("expiring-token", { expires: Date.now() + 60_000 })
		let finishRefresh!: () => void
		const refreshDelay = new Promise<void>((resolve) => {
			finishRefresh = resolve
		})
		const nextExpiry = Date.now() + 3600_000
		const deps = fakeOAuthDeps(async (credential) => {
			await refreshDelay
			return { ...credential, access: "refreshed-token", refresh: "rotated-refresh", expires: nextExpiry }
		})

		const first = handleAuthStatus(paths, deps)
		await vi.waitFor(() => expect(deps.refreshCalls).toHaveLength(1))
		const second = handleAuthStatus(paths, deps)
		finishRefresh()

		await expect(Promise.all([first, second])).resolves.toEqual([{ authenticated: true }, { authenticated: true }])
		expect(deps.refreshCalls).toHaveLength(1)
		const persisted = JSON.parse(readFileSync(paths.authPath, "utf-8")) as Record<string, Record<string, unknown>>
		expect(persisted[KIMCHI_PROVIDER_ID]).toMatchObject({
			access: "refreshed-token",
			refresh: "rotated-refresh",
			expires: nextExpiry,
		})
	})

	it("keeps an observed OAuth rejection after a process restart", async () => {
		writeOAuthCredential("dead-oauth-token")
		markCredentialStale(undefined, "kimchi-dev")
		markCredentialStale("dead-oauth-token", "kimchi-dev")
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: false })

		await expect(authStatusInNewProcess(paths)).resolves.toEqual({ authenticated: false })
	})

	it("does not apply a previous OAuth rejection to a new login", async () => {
		writeOAuthCredential("dead-oauth-token")
		markCredentialStale("dead-oauth-token", "kimchi-dev")

		writeOAuthCredential("fresh-oauth-token")
		await expect(authStatusInNewProcess(paths)).resolves.toEqual({ authenticated: true })
	})

	// ---------------------------------------------------------------------------
	// Legacy ID-token bearer recovery (stored schedule outlives the bearer)
	// ---------------------------------------------------------------------------

	describe("legacy ID-token bearer recovery", () => {
		/** Fixed fake-clock instant for exact timestamp assertions. */
		const FAKE_NOW = new Date("2025-02-03T04:05:06.789Z").getTime()
		const HOUR_MS = 3_600_000
		/** Stored response-derived schedule of every legacy fixture: 24h from the pinned instant. */
		const STORED_EXPIRES = FAKE_NOW + 24 * HOUR_MS

		beforeEach(() => {
			// Only Date is faked, matching the issuance tests in cli-auth/oauth.test.ts
			// and the recovery tests in auth/active-prompt-refresh.test.ts: the real
			// file-backed credential store, ModelRuntime, and fake transports keep
			// real timers while `Date.now()` stays pinned for exact expiry assertions.
			vi.useFakeTimers({ toFake: ["Date"] })
			vi.setSystemTime(FAKE_NOW)
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		/** Secret-free synthetic JWT with a numeric epoch-seconds exp. */
		function jwtWithExp(expMs: number): string {
			return `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(
				JSON.stringify({ exp: Math.floor(expMs / 1000) }),
			).toString("base64url")}.fixture-signature`
		}

		/** A legacy credential: fresh stored response-derived schedule (24h) while the
		 * selected ID-token bearer was persisted before the shared expiry rule. */
		function legacyIdTokenEntry(bearerExpiryMs: number): Record<string, unknown> {
			return {
				type: "oauth",
				tokenUrl: "https://issuer.invalid/oauth/token",
				clientId: "fake-issuer-client",
				access: jwtWithExp(bearerExpiryMs),
				refresh: "legacy-refresh",
				expires: STORED_EXPIRES,
				useIdToken: true,
				region: "us",
				audience: "https://llm.kimchi.dev",
				orgId: "org-legacy",
				orgName: "Legacy Org",
				idToken: jwtWithExp(bearerExpiryMs),
				accessToken: "legacy-raw-access",
			}
		}

		function writeLegacyIdTokenCredential(bearerExpiryMs: number): void {
			writeFileSync(paths.authPath, JSON.stringify({ "kimchi-dev": legacyIdTokenEntry(bearerExpiryMs) }))
		}

		/** Read a persisted credential entry from the shared store. */
		function readStoredProviderEntry(providerId: string): Record<string, unknown> {
			const stored = JSON.parse(readFileSync(paths.authPath, "utf-8")) as Record<string, Record<string, unknown>>
			const entry = stored[providerId]
			if (!entry) throw new Error(`expected a persisted ${providerId} credential`)
			return entry
		}

		/** Read the persisted canonical credential entry from the shared store. */
		function readStoredCanonical(): Record<string, unknown> {
			return readStoredProviderEntry(KIMCHI_PROVIDER_ID)
		}

		/** Install the fake OAuth provider while counting browser/login attempts so
		 * tests can assert the recovery never leaves the refresh path. */
		function installOAuthCountingBrowser(oauth: ReturnType<typeof fakeOAuthDeps>): {
			installOAuth: (runtime: ModelRuntime) => void
			browserLoginAttempts: () => number
		} {
			let loginAttempts = 0
			return {
				browserLoginAttempts: () => loginAttempts,
				installOAuth: (runtime: ModelRuntime): void => {
					oauth.installOAuth(runtime)
					const providerOAuth = runtime.getRegisteredProviderConfig("kimchi-dev")?.oauth
					if (!providerOAuth) throw new Error("expected canonical test OAuth")
					runtime.registerProvider("kimchi-dev", {
						oauth: Object.assign({}, providerOAuth, {
							login: (...args: Parameters<typeof providerOAuth.login>) => {
								loginAttempts++
								return providerOAuth.login(...args)
							},
						}),
					})
				},
			}
		}

		it.each([
			{ description: "expired", bearerExpiryMs: FAKE_NOW - 10 * 60_000 },
			{ description: "near-expiry renewal boundary", bearerExpiryMs: FAKE_NOW + 5 * 60_000 },
		])("authenticates an Agent auth status with a $description legacy ID-token bearer after one refresh", async ({
			bearerExpiryMs,
		}) => {
			writeLegacyIdTokenCredential(bearerExpiryMs)
			// A pre-existing concrete provider entry carries the same legacy bearer:
			// auth status must recover both it and the canonical entry, because prompt
			// requests resolve the concrete kimchi-dev/* providers directly.
			writeFileSync(
				paths.authPath,
				JSON.stringify({
					"kimchi-dev": legacyIdTokenEntry(bearerExpiryMs),
					"kimchi-dev/openai": legacyIdTokenEntry(bearerExpiryMs),
				}),
			)
			writeFileSync(paths.modelsPath, JSON.stringify({ providers: { "kimchi-dev/openai": {} } }))
			// Outside the five-minute default renewal window, per the legacy contract.
			const replacementExpiry = FAKE_NOW + 25 * HOUR_MS
			const replacementAccess = jwtWithExp(replacementExpiry)
			const oauth = fakeOAuthDeps((credential) => ({
				...credential,
				access: replacementAccess,
				expires: replacementExpiry,
			}))
			const browser = installOAuthCountingBrowser(oauth)

			await expect(handleAuthStatus(paths, browser)).resolves.toEqual({ authenticated: true })

			// Exactly one ordinary refresh through the existing path; no browser login.
			expect(oauth.refreshCalls).toHaveLength(1)
			expect(oauth.refreshCalls[0]).toMatchObject({ refresh: "legacy-refresh" })
			expect(browser.browserLoginAttempts()).toBe(0)
			// The corrected replacement is durable in the shared canonical entry and
			// fanned out to the concrete provider entry (pi-auth.ts), so neither keeps
			// the retired bearer or grant — the same discipline exercised end-to-end in
			// auth/active-prompt-refresh.test.ts.
			for (const providerId of [KIMCHI_PROVIDER_ID, "kimchi-dev/openai"]) {
				expect(readStoredProviderEntry(providerId)).toMatchObject({
					access: replacementAccess,
					// Non-rotating grant: the issuer kept the existing refresh token.
					refresh: "legacy-refresh",
					// Exact corrected schedule: the ID-token bearer no longer outlives it.
					expires: replacementExpiry,
					// Preserved token-selection and org/region/client/audience metadata.
					useIdToken: true,
					region: "us",
					audience: "https://llm.kimchi.dev",
					orgId: "org-legacy",
					orgName: "Legacy Org",
					tokenUrl: "https://issuer.invalid/oauth/token",
					clientId: "fake-issuer-client",
				})
				expect(readStoredProviderEntry(providerId).expires).toBeGreaterThan(FAKE_NOW + 5 * 60_000)
			}
		})

		it("accepts a replacement shorter than the forced minimum through one re-resolution and a single grant", async () => {
			writeLegacyIdTokenCredential(FAKE_NOW - 60_000)
			// Outside the ordinary five-minute window, but shorter than the forced
			// minimum implied by the 24h stored schedule: upstream rejects it once
			// on the forced call, then the existing resolver re-resolves without the
			// temporary minimum and accepts the already-durable replacement.
			const replacementExpiry = FAKE_NOW + 30 * 60_000
			const replacementAccess = jwtWithExp(replacementExpiry)
			const oauth = fakeOAuthDeps((credential) => ({
				...credential,
				access: replacementAccess,
				expires: replacementExpiry,
			}))
			const browser = installOAuthCountingBrowser(oauth)

			await expect(handleAuthStatus(paths, browser)).resolves.toEqual({ authenticated: true })

			// The durable refresh already happened on the forced call; the
			// re-resolution performs no second grant and no browser login.
			expect(oauth.refreshCalls).toHaveLength(1)
			expect(browser.browserLoginAttempts()).toBe(0)
			expect(readStoredCanonical()).toMatchObject({
				access: replacementAccess,
				refresh: "legacy-refresh",
				expires: replacementExpiry,
			})
		})

		it("does not force a refresh for a fresh legacy ID-token bearer", async () => {
			const bearerExpiryMs = FAKE_NOW + 12 * HOUR_MS
			const legacyAccess = jwtWithExp(bearerExpiryMs)
			writeLegacyIdTokenCredential(bearerExpiryMs)
			const oauth = fakeOAuthDeps((credential) => ({
				...credential,
				access: jwtWithExp(FAKE_NOW + 48 * HOUR_MS),
				expires: FAKE_NOW + 48 * HOUR_MS,
			}))

			await expect(handleAuthStatus(paths, oauth)).resolves.toEqual({ authenticated: true })

			expect(oauth.refreshCalls).toHaveLength(0)
			expect(readStoredCanonical()).toMatchObject({
				access: legacyAccess,
				refresh: "legacy-refresh",
				expires: STORED_EXPIRES,
			})
		})

		it("does not force a refresh for a legacy ID-token bearer without issuer refresh metadata", async () => {
			const legacyAccess = jwtWithExp(FAKE_NOW - 60_000)
			writeFileSync(
				paths.authPath,
				JSON.stringify({
					"kimchi-dev": {
						type: "oauth",
						access: legacyAccess,
						refresh: "legacy-refresh",
						expires: STORED_EXPIRES,
						useIdToken: true,
					},
				}),
			)
			const oauth = fakeOAuthDeps()

			await expect(handleAuthStatus(paths, oauth)).resolves.toEqual({ authenticated: true })

			expect(oauth.refreshCalls).toHaveLength(0)
			expect(readStoredCanonical()).toMatchObject({
				access: legacyAccess,
				refresh: "legacy-refresh",
				expires: STORED_EXPIRES,
			})
		})
	})

	function authStatusInNewProcess(paths: AuthStatusPaths): Promise<AuthStatusResponse> {
		const tsxCli = fileURLToPath(new URL("../../../../node_modules/tsx/dist/cli.mjs", import.meta.url))
		const moduleUrl = new URL("./auth-status.ts", import.meta.url).href
		const source = `import { handleAuthStatus } from ${JSON.stringify(moduleUrl)};
handleAuthStatus(JSON.parse(process.argv[2])).then((result) => process.stdout.write(JSON.stringify(result))).catch((error) => {
	console.error(error);
	process.exitCode = 1;
});`
		const scriptPath = join(dir, "auth-status-restart.mts")
		writeFileSync(scriptPath, source)
		const child = spawn(process.execPath, [tsxCli, scriptPath, JSON.stringify(paths)], {
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk
		})
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk
		})
		return new Promise((resolve, reject) => {
			child.once("error", reject)
			child.once("close", (code) => {
				if (code !== 0) {
					reject(new Error(`restarted auth-status process exited ${code}: ${stderr}`))
					return
				}
				try {
					resolve(JSON.parse(stdout) as AuthStatusResponse)
				} catch (error) {
					reject(error)
				}
			})
		})
	}

	async function startTokenEndpoint(respond: TokenResponder): Promise<string> {
		const server = createServer((request, response) => {
			if (request.method !== "POST") {
				response.writeHead(404).end()
				return
			}
			let body = ""
			request.setEncoding("utf-8")
			request.on("data", (chunk: string) => {
				body += chunk
			})
			request.on("end", () => {
				const params = new URLSearchParams(body)
				tokenRequests.push(params)
				const result = respond(params)
				if (!result) return
				response.writeHead(result.status, { "content-type": "application/json" })
				response.end(JSON.stringify(result.body))
			})
		})
		tokenServer = server
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(0, "127.0.0.1", resolve)
		})
		const address = server.address() as AddressInfo
		return `http://127.0.0.1:${address.port}/oauth/token`
	}

	async function startUnreachableTokenEndpoint(): Promise<string> {
		const tokenUrl = await startTokenEndpoint(() => ({ status: 500, body: {} }))
		const server = tokenServer
		if (!server) throw new Error("token endpoint was not started")
		server.closeAllConnections()
		await new Promise<void>((resolve) => server.close(() => resolve()))
		tokenServer = undefined
		return tokenUrl
	}

	function writeOAuthCredential(access: string, overrides: Record<string, unknown> = {}): void {
		writeFileSync(
			paths.authPath,
			JSON.stringify({
				"kimchi-dev": {
					type: "oauth",
					access,
					refresh: "refresh",
					expires: Date.now() + 3600_000,
					...overrides,
				},
			}),
		)
	}
})
