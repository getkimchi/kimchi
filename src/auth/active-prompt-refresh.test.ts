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
		const oauth = fakeOAuthDeps((credential) => ({
			...credential,
			access: "replacement-access",
			refresh: "rotated-refresh",
			expires: Date.now() + 3_600_000,
		}))

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

	it("retries a transient fan-out write and preserves the rotated grant for the active provider", async () => {
		writeOAuthCredential(Date.now() + 60_000)
		const oauth = fakeOAuthDeps((credential) => ({
			...credential,
			access: "replacement-access",
			refresh: "rotated-refresh",
			expires: Date.now() + 3_600_000,
		}))
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

		await expect(prepareActivePromptKimchiCredential(paths, oauth.installOAuth)).resolves.toBeUndefined()

		expect(isCredentialStale("expiring-access", "kimchi-dev")).toBe(false)
		expect(readStore()["kimchi-dev"]).toMatchObject({ access: "expiring-access", refresh: "original-refresh" })
	})

	it("preserves definitive invalid_grant errors", async () => {
		writeOAuthCredential(Date.now() + 60_000)
		const oauth = fakeOAuthDeps(() => {
			throw new OAuthTokenError("fake refresh grant revoked", { code: "invalid_grant", status: 400 })
		})

		await expect(prepareActivePromptKimchiCredential(paths, oauth.installOAuth)).rejects.toMatchObject({
			code: "oauth",
			cause: { code: "invalid_grant" },
		})
	})

	it("does not turn a credential-store failure into definitive rejection", async () => {
		const oauth = fakeOAuthDeps()
		writeFileSync(paths.authPath, "{")

		await expect(prepareActivePromptKimchiCredential(paths, oauth.installOAuth)).resolves.toBeUndefined()
		expect(oauth.refreshCalls).toHaveLength(0)
	})

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
