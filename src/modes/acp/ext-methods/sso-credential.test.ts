// Integration-style handler tests for `_kimchi.dev/sso_credential` against
// real temp credential stores (config.json + auth.json + models.json), like
// auth-status.test.ts. The lazy-refresh discipline is exercised end to end
// through a real ModelRuntime whose kimchi-dev provider carries a FAKE OAuth
// refresh handler (no network): an expiring stored token must be refreshed
// under the store lock and the refreshed credential persisted to auth.json.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RequestError } from "@agentclientprotocol/sdk"
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth"
import type { ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeApiKey } from "../../../config.js"
import { KIMCHI_PROVIDER_ID } from "../../../kimchi-provider.js"
import { handleSsoCredential, type SsoCredentialPaths } from "./sso-credential.js"

/** The oauth-config slice of `registerProvider`'s input (pi-coding-agent does
 * not export `ExtensionOAuthConfig` — derive it the same way flow.ts does). */
type ExtensionOAuthConfig = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]>["oauth"]
type ExtensionProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1]

/** Build the deps with an injectable fake OAuth handler, recording every
 * refresh call so tests can assert on the lazy-refresh discipline. */
function fakeOAuthDeps(refresh?: (credential: OAuthCredentials) => OAuthCredentials) {
	const refreshCalls: Array<Record<string, unknown>> = []
	const oauth: ExtensionOAuthConfig = {
		name: "test-sso",
		login: () => Promise.reject(new Error("login is not part of the credential export contract")),
		refreshToken: (credentials) => {
			refreshCalls.push(credentials as unknown as Record<string, unknown>)
			return Promise.resolve(refresh?.(credentials) ?? credentials)
		},
		getApiKey: (credentials) => credentials.access,
	}
	return {
		refreshCalls,
		installOAuth: (runtime: ModelRuntime): void => {
			runtime.registerProvider(KIMCHI_PROVIDER_ID, { oauth } satisfies ExtensionProviderConfig)
		},
	}
}

describe("handleSsoCredential", () => {
	let dir: string
	let paths: SsoCredentialPaths

	beforeEach(() => {
		vi.stubEnv("KIMCHI_API_KEY", undefined)
		dir = mkdtempSync(join(tmpdir(), "kimchi-sso-credential-"))
		paths = {
			authPath: join(dir, "auth.json"),
			modelsPath: join(dir, "models.json"),
			configPath: join(dir, "config.json"),
		}
		writeFileSync(
			paths.modelsPath,
			JSON.stringify({ providers: { [KIMCHI_PROVIDER_ID]: { baseUrl: "https://api.cast.ai/v1" } } }),
		)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		rmSync(dir, { recursive: true, force: true })
	})

	function writeSsoEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		const entry = {
			type: "oauth",
			access: "id-token",
			refresh: "refresh-token",
			expires: Date.now() + 3600_000,
			region: "us",
			useIdToken: true,
			idToken: "id-token",
			accessToken: "access-token",
			orgId: "516442fe-054a-49e2-ac2d-9dc9b104c3d2",
			orgName: "CAST AI",
			...overrides,
		}
		writeFileSync(paths.authPath, JSON.stringify({ [KIMCHI_PROVIDER_ID]: entry }))
		return entry
	}

	async function errorFrom(run: () => Promise<unknown>): Promise<RequestError> {
		try {
			await run()
		} catch (error) {
			return error as RequestError
		}
		throw new Error("expected the handler to throw")
	}

	it("returns the org-scoped credential for a fresh SSO entry", async () => {
		const entry = writeSsoEntry()
		const result = await handleSsoCredential(fakeOAuthDeps(), paths)
		expect(result).toEqual({
			credential: "id-token",
			orgId: "516442fe-054a-49e2-ac2d-9dc9b104c3d2",
			orgName: "CAST AI",
			region: "us",
			expiry: new Date(entry.expires as number).toISOString(),
		})
	})

	it("exposes the same bearer the harness sends for its own users-API calls (credential.access, not the raw accessToken extra)", async () => {
		writeSsoEntry({ access: "id-token", accessToken: "raw-access-token" })
		const result = await handleSsoCredential(fakeOAuthDeps(), paths)
		expect(result.credential).toBe("id-token")
		expect(result.credential).not.toBe("raw-access-token")
	})

	it("refreshes an expiring credential and persists the refreshed token to auth.json", async () => {
		// Below the five-minute lazy-refresh window: getAuth must run the
		// refresh (under the store lock) and persist before release — the
		// re-read after it must see the refreshed token and expiry.
		writeSsoEntry({ expires: Date.now() + 60_000 })
		const nextExpiry = Date.now() + 3600_000
		const deps = fakeOAuthDeps((credential) => ({
			...credential,
			access: "refreshed-token",
			expires: nextExpiry,
		}))

		const result = await handleSsoCredential(deps, paths)

		expect(deps.refreshCalls).toHaveLength(1)
		expect(result.credential).toBe("refreshed-token")
		expect(result.expiry).toBe(new Date(nextExpiry).toISOString())
		// Persisted before the handler returned: a direct read of auth.json
		// (what a naive client-side store read would see) now holds the
		// refreshed token too.
		const persisted = JSON.parse(readFileSync(paths.authPath, "utf-8")) as Record<string, Record<string, unknown>>
		expect(persisted[KIMCHI_PROVIDER_ID]?.access).toBe("refreshed-token")
	})

	it("does not refresh a credential inside the validity window", async () => {
		writeSsoEntry()
		const deps = fakeOAuthDeps()
		await handleSsoCredential(deps, paths)
		expect(deps.refreshCalls).toHaveLength(0)
	})

	it("rejects a key-based session with SSO_NOT_AUTHENTICATED (key sessions are out of scope)", async () => {
		writeApiKey("castai_v1_token", paths.configPath)
		const error = await errorFrom(() => handleSsoCredential(fakeOAuthDeps(), paths))
		expect(error.data).toMatchObject({ code: "SSO_NOT_AUTHENTICATED" })
	})

	it("rejects with SSO_NOT_AUTHENTICATED when neither store holds credentials", async () => {
		const error = await errorFrom(() => handleSsoCredential(fakeOAuthDeps(), paths))
		expect(error.data).toMatchObject({ code: "SSO_NOT_AUTHENTICATED" })
	})

	it("rejects an auth.json api_key entry (the key-login fan-out shape) with SSO_NOT_AUTHENTICATED", async () => {
		writeFileSync(paths.authPath, JSON.stringify({ [KIMCHI_PROVIDER_ID]: { type: "api_key", key: "castai_v1_token" } }))
		const error = await errorFrom(() => handleSsoCredential(fakeOAuthDeps(), paths))
		expect(error.data).toMatchObject({ code: "SSO_NOT_AUTHENTICATED" })
	})

	it("rejects an SSO entry without an orgId with SSO_NOT_AUTHENTICATED", async () => {
		writeSsoEntry({ orgId: undefined, orgName: undefined })
		const error = await errorFrom(() => handleSsoCredential(fakeOAuthDeps(), paths))
		expect(error.data).toMatchObject({ code: "SSO_NOT_AUTHENTICATED" })
	})

	it("maps a failed refresh to SSO_REFRESH_FAILED with the cause detail", async () => {
		writeSsoEntry({ expires: Date.now() + 60_000 })
		const deps = fakeOAuthDeps(() => {
			throw new Error("invalid_grant")
		})
		const error = await errorFrom(() => handleSsoCredential(deps, paths))
		expect(error.data).toMatchObject({ code: "SSO_REFRESH_FAILED", detail: "invalid_grant" })
	})

	// Store failures must never escape as raw errors — the typed contract says
	// clients branch on data.code. Corrupt auth.json surfaces through getAuth
	// as ModelsError("auth") ("Credential store read failed"), which maps to
	// SSO_STORE_UNAVAILABLE — NOT SSO_REFRESH_FAILED, which would send the
	// client into a refresh-retry loop against an unreadable store.
	it("maps a corrupt auth.json to SSO_STORE_UNAVAILABLE", async () => {
		writeFileSync(paths.authPath, "{corrupt")
		const error = await errorFrom(() => handleSsoCredential(fakeOAuthDeps(), paths))
		expect(error.data).toMatchObject({ code: "SSO_STORE_UNAVAILABLE" })
	})

	// The store is intentionally tolerant: a missing models.json does not break
	// the export (ModelRuntime.create accepts it absent) — the credential comes
	// from auth.json alone.
	it("tolerates a missing models.json and still returns the credential", async () => {
		const entry = writeSsoEntry()
		rmSync(paths.modelsPath)
		await expect(handleSsoCredential(fakeOAuthDeps(), paths)).resolves.toMatchObject({
			credential: "id-token",
			orgId: entry.orgId,
		})
	})
})
