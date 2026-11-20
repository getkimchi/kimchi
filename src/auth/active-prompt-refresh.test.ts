import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OAuthTokenError } from "../cli-auth/oauth.js"
import { isCredentialStale, resetCredentialStalenessForTests } from "../credential-staleness.js"
import { installKimchiOAuth } from "../extensions/login/flow.js"
import { fakeOAuthDeps } from "../modes/acp/ext-methods/oauth-test-utils.js"
import { syncOAuthCredentialToKimchiProviders } from "../pi-auth.js"
import { prepareActivePromptKimchiCredential } from "./active-prompt-refresh.js"
import { shouldReusePreparedOAuthCredential } from "./short-lived-credential-handoff.js"

vi.mock("../pi-auth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../pi-auth.js")>()
	return { ...actual, syncOAuthCredentialToKimchiProviders: vi.fn(actual.syncOAuthCredentialToKimchiProviders) }
})

describe("active prompt Kimchi credential preparation", () => {
	let agentDir: string
	let paths: { authPath: string; modelsPath: string }

	beforeEach(() => {
		resetCredentialStalenessForTests()
		vi.mocked(syncOAuthCredentialToKimchiProviders).mockClear()
		agentDir = mkdtempSync(join(tmpdir(), "kimchi-active-prompt-refresh-"))
		paths = { authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") }
		writeFileSync(paths.modelsPath, JSON.stringify({ providers: { "kimchi-dev/openai": {} } }))
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		rmSync(agentDir, { recursive: true, force: true })
	})

	it("refreshes once and persists the replacement to canonical and active sub-provider entries", async () => {
		writeOAuthCredential(Date.now() + 60_000)
		const oauth = rotatingOAuthDeps()

		await prepareActivePromptKimchiCredential(paths, oauth.installOAuth)
		await prepareActivePromptKimchiCredential(paths, oauth.installOAuth)

		expect(oauth.refreshCalls).toHaveLength(1)
		const stored = readStore()
		for (const providerId of ["kimchi-dev", "kimchi-dev/openai"]) {
			expect(stored[providerId]).toMatchObject({ access: "replacement-access", refresh: "rotated-refresh" })
		}
	})

	it("fans out refresh-token-only rotation resolved through the canonical ModelRuntime", async () => {
		const expires = Date.now() + 60_000
		writeOAuthCredential(expires)
		const original = readStore()["kimchi-dev"]
		writeFileSync(paths.authPath, JSON.stringify({ "kimchi-dev": original, "kimchi-dev/openai": original }))
		const oauth = fakeOAuthDeps((credential) => ({ ...credential, refresh: "rotated-refresh" }))

		await prepareActivePromptKimchiCredential(paths, oauth.installOAuth)

		expect(oauth.refreshCalls).toHaveLength(1)
		const stored = readStore()
		for (const providerId of ["kimchi-dev", "kimchi-dev/openai"]) {
			expect(stored[providerId]).toMatchObject({ access: "expiring-access", refresh: "rotated-refresh", expires })
		}
	})

	it("fans out a coalesced canonical replacement to a stale active provider without another grant", async () => {
		writeFileSync(
			paths.authPath,
			JSON.stringify({
				"kimchi-dev": {
					type: "oauth",
					access: "replacement-access",
					refresh: "rotated-refresh",
					expires: Date.now() + 3_600_000,
				},
				"kimchi-dev/openai": {
					type: "oauth",
					access: "expiring-access",
					refresh: "original-refresh",
					expires: Date.now() + 60_000,
				},
			}),
		)
		const oauth = fakeOAuthDeps()

		await prepareActivePromptKimchiCredential(paths, oauth.installOAuth, "kimchi-dev/openai")

		expect(oauth.refreshCalls).toHaveLength(0)
		expect(readStore()["kimchi-dev/openai"]).toMatchObject({ access: "replacement-access", refresh: "rotated-refresh" })
	})

	it("fans out expiry-only active drift before request-time auth without an isolated grant", async () => {
		const canonicalExpires = Date.now() + 3_600_000
		const sharedCredential = { access: "fresh-shared-access", refresh: "shared-refresh" }
		writeFileSync(
			paths.authPath,
			JSON.stringify({
				"kimchi-dev": { type: "oauth", ...sharedCredential, expires: canonicalExpires },
				"kimchi-dev/openai": {
					type: "oauth",
					...sharedCredential,
					expires: Date.now() + 60_000,
				},
			}),
		)
		const oauth = rotatingOAuthDeps()

		await expect(prepareActivePromptKimchiCredential(paths, oauth.installOAuth, "kimchi-dev/openai")).resolves.toBe(
			"ready",
		)

		const runtime = await ModelRuntime.create({ authPath: paths.authPath, modelsPath: null })
		oauth.installOAuth(runtime)
		const canonicalOAuth = runtime.getRegisteredProviderConfig("kimchi-dev")?.oauth
		if (!canonicalOAuth) throw new Error("expected canonical test OAuth")
		runtime.registerProvider("kimchi-dev/openai", {
			oauth: canonicalOAuth,
			baseUrl: "https://example.invalid/openai/v1",
		})
		await expect(runtime.getAuth("kimchi-dev/openai")).resolves.toMatchObject({
			auth: { apiKey: sharedCredential.access },
		})
		expect(oauth.refreshCalls).toHaveLength(0)
		const stored = readStore()
		for (const providerId of ["kimchi-dev", "kimchi-dev/openai"]) {
			expect(stored[providerId]).toMatchObject({ ...sharedCredential, expires: canonicalExpires })
		}
	})

	it("reuses a short-lived replacement across two request-time lookups in one prompt", async () => {
		writeOAuthCredential(Date.now() + 60_000)
		let grantCount = 0
		const oauth = fakeOAuthDeps((credential) => {
			grantCount++
			return {
				...credential,
				access: `replacement-access-${grantCount}`,
				refresh: `rotated-refresh-${grantCount}`,
				expires: Date.now() + 60_000,
			}
		})
		const owner: object = {}
		const installOwnerScopedOAuth = (runtime: ModelRuntime): void => {
			oauth.installOAuth(runtime)
			const providerOAuth = runtime.getRegisteredProviderConfig("kimchi-dev")?.oauth
			const refreshTransport = providerOAuth?.refreshToken
			if (!providerOAuth || !refreshTransport) throw new Error("expected fake refresh transport")
			const refreshToken: typeof refreshTransport = (credential, signal) =>
				shouldReusePreparedOAuthCredential(paths.authPath, credential, owner)
					? Promise.resolve(credential)
					: refreshTransport(credential, signal)
			runtime.registerProvider("kimchi-dev", {
				oauth: Object.assign({}, providerOAuth, { refreshToken }),
			})
		}
		await expect(
			prepareActivePromptKimchiCredential(paths, installOwnerScopedOAuth, "kimchi-dev/openai", owner),
		).resolves.toBe("ready")
		const persistedCanonical = readStoredCredential("kimchi-dev", paths.authPath)
		if (persistedCanonical?.type !== "oauth") throw new Error("expected the canonical replacement")
		expect(shouldReusePreparedOAuthCredential(paths.authPath, persistedCanonical, owner)).toBe(true)
		const runtime = await ModelRuntime.create({ authPath: paths.authPath, modelsPath: null })
		installOwnerScopedOAuth(runtime)
		const canonicalOAuth = runtime.getRegisteredProviderConfig("kimchi-dev")?.oauth
		if (!canonicalOAuth) throw new Error("expected canonical test OAuth")
		runtime.registerProvider("kimchi-dev/openai", { oauth: canonicalOAuth })

		for (let request = 0; request < 2; request++) {
			await expect(runtime.getAuth("kimchi-dev/openai")).resolves.toMatchObject({
				auth: { apiKey: "replacement-access-1" },
			})
		}

		expect(oauth.refreshCalls).toHaveLength(1)
		const stored = readStore()
		for (const field of ["access", "refresh", "expires"]) {
			expect(stored["kimchi-dev/openai"]?.[field]).toBe(stored["kimchi-dev"]?.[field])
		}
	})

	it("does not overwrite a distinct active credential outside the refresh window", async () => {
		const activeCredential = {
			type: "oauth",
			access: "independent-active-access",
			refresh: "independent-active-refresh",
			expires: Date.now() + 10 * 60_000,
		}
		writeFileSync(
			paths.authPath,
			JSON.stringify({
				"kimchi-dev": {
					type: "oauth",
					access: "replacement-access",
					refresh: "rotated-refresh",
					expires: Date.now() + 20 * 60_000,
				},
				"kimchi-dev/openai": activeCredential,
			}),
		)
		const oauth = fakeOAuthDeps()

		await prepareActivePromptKimchiCredential(paths, oauth.installOAuth, "kimchi-dev/openai")

		expect(oauth.refreshCalls).toHaveLength(0)
		expect(syncOAuthCredentialToKimchiProviders).not.toHaveBeenCalled()
		expect(readStore()["kimchi-dev/openai"]).toEqual(activeCredential)
	})

	it("does not refresh Kimchi credentials for an unrelated active provider", async () => {
		writeOAuthCredential(Date.now() + 60_000)
		const oauth = fakeOAuthDeps()

		await prepareActivePromptKimchiCredential(paths, oauth.installOAuth, "anthropic")

		expect(oauth.refreshCalls).toHaveLength(0)
		expect(syncOAuthCredentialToKimchiProviders).not.toHaveBeenCalled()
		expect(readStore()).toMatchObject({ "kimchi-dev": { access: "expiring-access", refresh: "original-refresh" } })
	})

	it("retries a transient fan-out write and preserves the rotated grant for the active provider", async () => {
		writeOAuthCredential(Date.now() + 60_000)
		const oauth = rotatingOAuthDeps()
		vi.mocked(syncOAuthCredentialToKimchiProviders).mockRejectedValueOnce(new Error("fake transient store write"))

		await prepareActivePromptKimchiCredential(paths, oauth.installOAuth, "kimchi-dev/openai")

		expect(oauth.refreshCalls).toHaveLength(1)
		expect(syncOAuthCredentialToKimchiProviders).toHaveBeenCalledTimes(2)
		const stored = readStore()
		for (const providerId of ["kimchi-dev", "kimchi-dev/openai"]) {
			expect(stored[providerId]).toMatchObject({ access: "replacement-access", refresh: "rotated-refresh" })
		}
	})

	it("leaves API-key credentials untouched", async () => {
		writeFileSync(paths.authPath, JSON.stringify({ "kimchi-dev": { type: "api_key", key: "configured-key" } }))
		const oauth = fakeOAuthDeps()

		await prepareActivePromptKimchiCredential(paths, oauth.installOAuth)

		expect(oauth.refreshCalls).toHaveLength(0)
		expect(readStore()["kimchi-dev"]).toEqual({ type: "api_key", key: "configured-key" })
	})

	it("rejects unsafe active-only fallback after a transient canonical failure and recovers on retry", async () => {
		writeOAuthCredential(Date.now() + 60_000)
		const original = readStore()["kimchi-dev"]
		writeFileSync(paths.authPath, JSON.stringify({ "kimchi-dev": original, "kimchi-dev/openai": original }))
		let failNextRefresh = true
		const oauth = fakeOAuthDeps((credential) => {
			if (failNextRefresh) {
				failNextRefresh = false
				throw new Error("loopback temporarily unavailable")
			}
			return {
				...credential,
				access: "replacement-access-2",
				refresh: "rotated-refresh-2",
				expires: Date.now() + 3_600_000,
			}
		})

		await expect(prepareActivePromptKimchiCredential(paths, oauth.installOAuth, "kimchi-dev/openai")).resolves.toBe(
			"oauth_refresh_failed",
		)

		expect(isCredentialStale("expiring-access", "kimchi-dev")).toBe(false)
		expect(readStore()["kimchi-dev"]).toEqual(original)
		expect(readStore()["kimchi-dev/openai"]).toEqual(original)
		await expect(prepareActivePromptKimchiCredential(paths, oauth.installOAuth, "kimchi-dev/openai")).resolves.toBe(
			"ready",
		)
		expect(oauth.refreshCalls).toHaveLength(2)
		const persisted = readStore()
		for (const field of ["access", "refresh", "expires"]) {
			expect(persisted["kimchi-dev/openai"]?.[field]).toBe(persisted["kimchi-dev"]?.[field])
		}
		expect(persisted["kimchi-dev"]).toMatchObject({ access: "replacement-access-2", refresh: "rotated-refresh-2" })
	})

	it("preserves the original prompt path for OAuth without issuer refresh metadata", async () => {
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
		writeFileSync(
			paths.authPath,
			JSON.stringify({
				"kimchi-dev": { type: "oauth", access: "legacy-access", refresh: "legacy-refresh", expires: Date.now() + 1000 },
			}),
		)

		await expect(
			prepareActivePromptKimchiCredential(
				paths,
				(runtime) => installKimchiOAuth(runtime, paths.authPath),
				"kimchi-dev/eu",
			),
		).resolves.toBe("ready")
		expect(syncOAuthCredentialToKimchiProviders).not.toHaveBeenCalled()
		expect(readStore()["kimchi-dev"]).toMatchObject({ access: "legacy-access", refresh: "legacy-refresh" })
	})

	it("classifies definitive invalid_grant without throwing into an input hook", async () => {
		writeOAuthCredential(Date.now() + 60_000)
		const oauth = fakeOAuthDeps(() => {
			throw new OAuthTokenError("fake refresh grant revoked", { code: "invalid_grant", status: 400 })
		})

		await expect(prepareActivePromptKimchiCredential(paths, oauth.installOAuth)).resolves.toBe("oauth_revoked")
		expect(oauth.refreshCalls).toHaveLength(1)
	})

	it("retries fan-out when the previous failure left the active OAuth entry missing", async () => {
		writeOAuthCredential(Date.now() + 60_000)
		const oauth = rotatingOAuthDeps()
		const sync = vi.mocked(syncOAuthCredentialToKimchiProviders)
		sync
			.mockRejectedValueOnce(new Error("first fan-out failure"))
			.mockRejectedValueOnce(new Error("second fan-out failure"))

		await expect(prepareActivePromptKimchiCredential(paths, oauth.installOAuth, "kimchi-dev/openai")).resolves.toBe(
			"credential_sync_failed",
		)
		expect(readStore()["kimchi-dev/openai"]).toBeUndefined()
		await expect(prepareActivePromptKimchiCredential(paths, oauth.installOAuth, "kimchi-dev/openai")).resolves.toBe(
			"ready",
		)

		expect(oauth.refreshCalls).toHaveLength(1)
		expect(sync).toHaveBeenCalledTimes(3)
		expect(readStore()["kimchi-dev/openai"]).toMatchObject({ access: "replacement-access", refresh: "rotated-refresh" })
	})

	it("defers a retired active grant until fan-out succeeds, without another token request", async () => {
		writeOAuthCredential(Date.now() + 60_000)
		const original = readStore()["kimchi-dev"]
		writeFileSync(paths.authPath, JSON.stringify({ "kimchi-dev": original, "kimchi-dev/openai": original }))
		const oauth = rotatingOAuthDeps()
		const sync = vi.mocked(syncOAuthCredentialToKimchiProviders)
		const defaultSync = sync.getMockImplementation()
		expect(defaultSync).toBeDefined()
		sync.mockRejectedValue(new TypeError("unexpected error containing original-refresh"))
		const error = vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(prepareActivePromptKimchiCredential(paths, oauth.installOAuth, "kimchi-dev/openai")).resolves.toBe(
			"credential_sync_failed",
		)

		expect(oauth.refreshCalls).toHaveLength(1)
		expect(sync).toHaveBeenCalledTimes(2)
		expect(readStore()["kimchi-dev/openai"]).toMatchObject({ refresh: "original-refresh" })
		expect(error).toHaveBeenCalledWith({
			event: "kimchi.oauth.refresh",
			outcome: "sync_failed",
			errorType: "TypeError",
		})
		expect(JSON.stringify(error.mock.calls)).not.toContain("original-refresh")

		if (!defaultSync) throw new Error("missing default fan-out")
		sync.mockImplementation(defaultSync)
		await expect(prepareActivePromptKimchiCredential(paths, oauth.installOAuth, "kimchi-dev/openai")).resolves.toBe(
			"ready",
		)
		expect(oauth.refreshCalls).toHaveLength(1)
		expect(sync).toHaveBeenCalledTimes(3)
		expect(readStore()["kimchi-dev/openai"]).toMatchObject({ refresh: "rotated-refresh" })
	})

	function rotatingOAuthDeps(): ReturnType<typeof fakeOAuthDeps> {
		return fakeOAuthDeps((credential) => ({
			...credential,
			access: "replacement-access",
			refresh: "rotated-refresh",
			expires: Date.now() + 3_600_000,
		}))
	}

	function writeOAuthCredential(expires: number): void {
		writeFileSync(
			paths.authPath,
			JSON.stringify({
				"kimchi-dev": {
					type: "oauth",
					tokenUrl: "https://issuer.invalid/oauth/token",
					clientId: "fake-issuer-client",
					access: "expiring-access",
					refresh: "original-refresh",
					expires,
				},
			}),
		)
	}

	function readStore(): Record<string, Record<string, unknown>> {
		return JSON.parse(readFileSync(paths.authPath, "utf-8")) as Record<string, Record<string, unknown>>
	}
})
