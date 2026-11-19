import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OAuthTokenError } from "../cli-auth/oauth.js"
import { isCredentialStale, resetCredentialStalenessForTests } from "../credential-staleness.js"
import { fakeOAuthDeps } from "../modes/acp/ext-methods/oauth-test-utils.js"
import { syncOAuthCredentialToKimchiProviders } from "../pi-auth.js"
import { prepareActivePromptKimchiCredential } from "./active-prompt-refresh.js"

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

	it("falls through without marking credentials stale after a transient refresh failure", async () => {
		writeOAuthCredential(Date.now() + 60_000)
		const oauth = fakeOAuthDeps(() => {
			throw new Error("loopback temporarily unavailable")
		})

		await expect(prepareActivePromptKimchiCredential(paths, oauth.installOAuth)).resolves.toBe("ready")

		expect(isCredentialStale("expiring-access", "kimchi-dev")).toBe(false)
		expect(readStore()["kimchi-dev"]).toMatchObject({ access: "expiring-access", refresh: "original-refresh" })
	})

	it("classifies definitive invalid_grant without throwing into an input hook", async () => {
		writeOAuthCredential(Date.now() + 60_000)
		const oauth = fakeOAuthDeps(() => {
			throw new OAuthTokenError("fake refresh grant revoked", { code: "invalid_grant", status: 400 })
		})

		await expect(prepareActivePromptKimchiCredential(paths, oauth.installOAuth)).resolves.toBe("oauth_revoked")
		expect(oauth.refreshCalls).toHaveLength(1)
	})

	it("logs token-free diagnostics when fan-out fails twice", async () => {
		writeOAuthCredential(Date.now() + 60_000)
		const oauth = rotatingOAuthDeps()
		vi.mocked(syncOAuthCredentialToKimchiProviders).mockRejectedValue(
			new TypeError("unexpected error containing original-refresh"),
		)
		const error = vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(prepareActivePromptKimchiCredential(paths, oauth.installOAuth, "kimchi-dev/openai")).resolves.toBe(
			"ready",
		)

		expect(oauth.refreshCalls).toHaveLength(1)
		expect(syncOAuthCredentialToKimchiProviders).toHaveBeenCalledTimes(2)
		expect(error).toHaveBeenCalledWith({
			event: "kimchi.oauth.refresh",
			outcome: "preflight_failed",
			errorType: "TypeError",
		})
		expect(JSON.stringify(error.mock.calls)).not.toContain("original-refresh")
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
