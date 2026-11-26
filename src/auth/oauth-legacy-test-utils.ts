import { readFileSync, writeFileSync } from "node:fs"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { fakeOAuthDeps } from "../modes/acp/ext-methods/oauth-test-utils.js"

// Test-only fixtures shared by the legacy ID-token bearer recovery suites
// (auth/active-prompt-refresh.test.ts and modes/acp/ext-methods/auth-status.test.ts).
// Keep this module out of production barrels.

/** Fixed fake-clock instant for exact timestamp assertions. */
export const FAKE_NOW = new Date("2025-02-03T04:05:06.789Z").getTime()
export const HOUR_MS = 3_600_000
/** Stored response-derived schedule of every legacy fixture: 24h from the pinned instant. */
export const STORED_EXPIRES = FAKE_NOW + 24 * HOUR_MS

/** Secret-free synthetic JWT with a numeric epoch-seconds exp. */
export function jwtWithExp(expMs: number): string {
	return `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(
		JSON.stringify({ exp: Math.floor(expMs / 1000) }),
	).toString("base64url")}.fixture-signature`
}

/** A legacy credential: fresh stored response-derived schedule (24h) while
 * the selected ID-token bearer was persisted before the shared expiry rule. */
export function legacyIdTokenEntry(
	bearerExpiryMs: number,
	storedExpiresMs: number = STORED_EXPIRES,
): Record<string, unknown> {
	return {
		type: "oauth",
		tokenUrl: "https://issuer.invalid/oauth/token",
		clientId: "fake-issuer-client",
		access: jwtWithExp(bearerExpiryMs),
		refresh: "legacy-refresh",
		expires: storedExpiresMs,
		useIdToken: true,
		region: "us",
		audience: "https://llm.kimchi.dev",
		orgId: "org-legacy",
		orgName: "Legacy Org",
		idToken: jwtWithExp(bearerExpiryMs),
		accessToken: "legacy-raw-access",
	}
}

/** Persist the canonical legacy ID-token credential to the auth store at authPath. */
export function writeLegacyIdTokenCredential(
	authPath: string,
	bearerExpiryMs: number,
	storedExpiresMs: number = STORED_EXPIRES,
): void {
	writeFileSync(authPath, JSON.stringify({ "kimchi-dev": legacyIdTokenEntry(bearerExpiryMs, storedExpiresMs) }))
}

/** Read the persisted credential store at authPath. */
export function readAuthStore(authPath: string): Record<string, Record<string, unknown>> {
	return JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, Record<string, unknown>>
}

/** Read a persisted credential entry from the shared store at authPath. */
export function readStoredProviderEntry(authPath: string, providerId: string): Record<string, unknown> {
	const stored = readAuthStore(authPath)
	const entry = stored[providerId]
	if (!entry) throw new Error(`expected a persisted ${providerId} credential`)
	return entry
}

/** Install the fake OAuth provider while counting browser/login attempts so
 * tests can assert the recovery never leaves the refresh path. */
export function installOAuthCountingBrowser(oauth: ReturnType<typeof fakeOAuthDeps>): {
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
