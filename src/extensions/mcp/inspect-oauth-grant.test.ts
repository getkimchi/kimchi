import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const credentialAccount = vi.hoisted(() => ({
	value: { status: "absent" } as
		| { status: "present"; serverUrl?: string }
		| { status: "absent" }
		| { status: "unavailable" },
	error: undefined as Error | undefined,
}))
const tokensForUrl = vi.hoisted(() => ({
	value: { status: "absent" } as
		| { status: "present"; tokens: Record<string, unknown> }
		| { status: "absent" }
		| { status: "unavailable"; message: string },
	error: undefined as Error | undefined,
}))

const installKeyringRequireBridge = vi.hoisted(() => vi.fn())
vi.mock("./keyring-require-bridge.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./keyring-require-bridge.js")>()
	return {
		...actual,
		installKeyringRequireBridge,
		inspectMcpCredentialAccount: () => {
			if (credentialAccount.error) throw credentialAccount.error
			return credentialAccount.value
		},
	}
})

vi.mock("pi-mcp-adapter/oauth", async (importOriginal) => {
	const actual = await importOriginal<typeof import("pi-mcp-adapter/oauth")>()
	return {
		...actual,
		inspectMcpOAuthTokensForUrl: () => {
			if (tokensForUrl.error) throw tokensForUrl.error
			return tokensForUrl.value
		},
	}
})

import { inspectMcpOAuthGrant } from "./inspect-oauth-grant.js"
import { McpKeychainDeniedError, McpKeychainUnavailableError } from "./keyring-require-bridge.js"

const URL = "https://example.test/mcp"

beforeEach(() => {
	credentialAccount.value = { status: "absent" }
	credentialAccount.error = undefined
	tokensForUrl.value = { status: "absent" }
	tokensForUrl.error = undefined
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("inspectMcpOAuthGrant", () => {
	it("reports found:false when no account exists", () => {
		expect(inspectMcpOAuthGrant("granola")).toEqual({ found: false })
	})

	it("reports the bound URL and presence booleans with a pinned expiry window", () => {
		credentialAccount.value = { status: "present", serverUrl: URL }
		tokensForUrl.value = {
			status: "present",
			tokens: { accessToken: "[REDACTED-GENERIC_SECRET]", expiresAt: 1_800_000_000, scope: "openid email" },
		}

		expect(inspectMcpOAuthGrant("granola", { now: () => 1_799_999_640_000 })).toEqual({
			found: true,
			serverUrl: URL,
			tokens: {
				hasAccessToken: true,
				hasRefreshToken: false,
				expiresAt: 1_800_000_000,
				expiresInSec: 360,
				scope: "openid email",
			},
		})
	})

	it("flags refresh-token presence and a negative expiry window", () => {
		credentialAccount.value = { status: "present", serverUrl: URL }
		tokensForUrl.value = {
			status: "present",
			tokens: {
				accessToken: "token-sealed-access-9x",
				refreshToken: "token-sealed-refresh-7q",
				expiresAt: 1_800_000_000,
			},
		}

		expect(inspectMcpOAuthGrant("granola", { now: () => 1_800_000_060_000 }).tokens).toMatchObject({
			hasAccessToken: true,
			hasRefreshToken: true,
			expiresInSec: -60,
		})
	})

	it("installs the keyring require bridge before any adapter token read", () => {
		credentialAccount.value = { status: "present", serverUrl: URL }
		inspectMcpOAuthGrant("granola")
		expect(installKeyringRequireBridge).toHaveBeenCalled()
	})

	it("surfaces a consent denial during the tokens read", () => {
		credentialAccount.value = { status: "present", serverUrl: URL }
		tokensForUrl.error = new McpKeychainDeniedError("sha256-x")
		expect(() => inspectMcpOAuthGrant("granola")).toThrow(McpKeychainDeniedError)
	})

	it("surfaces a locked keychain during the tokens read", () => {
		credentialAccount.value = { status: "present", serverUrl: URL }
		tokensForUrl.error = new McpKeychainUnavailableError("locked")
		expect(() => inspectMcpOAuthGrant("granola")).toThrow(McpKeychainUnavailableError)
	})

	it("returns only found and serverUrl when the token payload is absent or unreadable", () => {
		for (const tokens of [{ status: "absent" as const }, { status: "unavailable" as const, message: "locked" }]) {
			credentialAccount.value = { status: "present", serverUrl: URL }
			tokensForUrl.value = tokens
			expect(inspectMcpOAuthGrant("granola")).toEqual({ found: true, serverUrl: URL })
		}
		credentialAccount.value = { status: "present", serverUrl: URL }
		tokensForUrl.error = new Error("backend blew up")
		expect(inspectMcpOAuthGrant("granola")).toEqual({ found: true, serverUrl: URL })
	})

	it("returns only found when the account carries no serverUrl", () => {
		credentialAccount.value = { status: "present" }
		expect(inspectMcpOAuthGrant("granola")).toEqual({ found: true })
	})

	it("throws with a recovery hint when the account cannot be verified", () => {
		credentialAccount.value = { status: "unavailable" }
		expect(() => inspectMcpOAuthGrant("granola")).toThrow(/could not be read.*forget-grant granola/)
	})

	it("never leaks token values into the serialized result", () => {
		credentialAccount.value = { status: "present", serverUrl: URL }
		tokensForUrl.value = {
			status: "present",
			tokens: { accessToken: "token-sealed-access-9x", refreshToken: "token-sealed-refresh-7q" },
		}
		const serialized = JSON.stringify({ ok: true, name: "granola", ...inspectMcpOAuthGrant("granola") })
		expect(serialized).not.toContain("token-sealed-access-9x")
		expect(serialized).not.toContain("token-sealed-refresh-7q")
	})
})
