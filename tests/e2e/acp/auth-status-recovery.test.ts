// ACP integration — `_kimchi.dev/auth_status` recovers a legacy ID-token
// credential through the real registration/dispatch surface (server.ts
// extMethod), not a direct handler invocation. This is the E2E counterpart of
// the unit suites in src/modes/acp/ext-methods/auth-status.test.ts: the
// canonical credential's stored response-derived schedule (24h) outlives its
// expired selected ID-token bearer, so auth status must refresh through the
// loopback token endpoint and fan the replacement out to the concrete provider.

import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	type FakeOAuthRefreshServer,
	seedLegacyIdTokenCredentials,
	startFakeOAuthRefreshServer,
	syntheticIdTokenJwt,
} from "../tui/support/oauth-refresh.js"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"

const HOUR_MS = 3_600_000

/** Documented OAuth storage safety margin subtracted from every response lifetime. */
const EXPIRY_MARGIN_MS = 60_000

/** Replacement lifetime for the seeded legacy credential. 25h: beyond the
 * legacy 24h stored schedule so the forced legacy refresh minimum accepts the
 * replacement in a single grant (no re-resolution second grant). */
const REPLACEMENT_EXPIRES_IN_SECONDS = 90_000

describe("ACP integration — auth status recovers a legacy ID-token credential", () => {
	let fixture: AcpFixture
	let oauth: FakeOAuthRefreshServer
	let authPath = ""
	let replacementIdToken = ""

	beforeEach(async () => {
		// The replacement ID-token JWT lives far beyond the response lifetime,
		// so the corrected stored expiry is the response lifetime minus margin.
		replacementIdToken = syntheticIdTokenJwt(Date.now() + 48 * HOUR_MS)
		oauth = await startFakeOAuthRefreshServer({
			expiresInSeconds: REPLACEMENT_EXPIRES_IN_SECONDS,
			idToken: replacementIdToken,
		})
		fixture = await startAcpFixture({
			artifactName: "auth-status-recovery",
			// models.json declares the concrete Kimchi provider, so the fan-out
			// writes the concrete `kimchi-dev/openai` entry too.
			providerId: "kimchi-dev/openai",
			defaultModel: "basic",
			responses: [],
			seedHome: (homeDir) => {
				// Pre-start seeding: clears config.apiKey (no API-key short-circuit)
				// and persists canonical plus concrete legacy ID-token credentials
				// with a future stored response expiry and an expired JWT bearer
				// pointing at the loopback issuer.
				authPath = seedLegacyIdTokenCredentials(homeDir, oauth.tokenUrl)
			},
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
		await oauth.close()
	})

	it("refreshes the expired ID-token bearer and fans the replacement out to both store entries", async () => {
		// Startup model discovery (`updateModelsConfig` with refreshOAuth) already
		// consumed the pre-start seeded legacy credential and its single grant
		// before `initialize` returned. Re-seed the canonical and concrete legacy
		// entries and clear the fake issuer's grant ledger so the measured
		// refresh is unequivocally performed by auth status, not by startup.
		authPath = seedLegacyIdTokenCredentials(fixture.homeDir, oauth.tokenUrl)
		oauth.grants.length = 0

		const requestStartedAt = Date.now()
		const status = await fixture.conn.request("_kimchi.dev/auth_status", {})
		const requestFinishedAt = Date.now()

		expect(status).toEqual({ authenticated: true })
		// Exactly one refresh grant, using the original (legacy) refresh token.
		expect(oauth.grants).toEqual([{ grantType: "refresh_token", refreshToken: "e2e-original-refresh" }])

		const stored = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>
		for (const providerId of ["kimchi-dev", "kimchi-dev/openai"]) {
			expect(stored[providerId]).toMatchObject({
				// Selected-ID-token mode: the replacement bearer is the rotated
				// JWT ID token, not the raw access token.
				access: replacementIdToken,
				refresh: "e2e-rotated-refresh",
				useIdToken: true,
			})
		}
		// Matching corrected expiry across the canonical and concrete entries:
		// the response lifetime minus the safety margin, replacing the legacy
		// stored schedule the expired bearer used to outlive.
		const canonicalExpiry = stored["kimchi-dev"]?.expires
		const concreteExpiry = stored["kimchi-dev/openai"]?.expires
		expect(typeof canonicalExpiry).toBe("number")
		expect(concreteExpiry).toBe(canonicalExpiry)
		const replacementLifetimeMs = REPLACEMENT_EXPIRES_IN_SECONDS * 1000 - EXPIRY_MARGIN_MS
		expect(canonicalExpiry).toBeGreaterThanOrEqual(requestStartedAt + replacementLifetimeMs)
		expect(canonicalExpiry).toBeLessThanOrEqual(requestFinishedAt + replacementLifetimeMs)
		// The retired expired bearer and original grant are gone from both entries.
		for (const providerId of ["kimchi-dev", "kimchi-dev/openai"]) {
			expect(stored[providerId]?.refresh).not.toBe("e2e-original-refresh")
		}
		expect(JSON.stringify(stored)).not.toContain("e2e-legacy-raw-access")
	})
})
