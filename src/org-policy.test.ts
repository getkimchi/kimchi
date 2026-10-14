import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { type AllowedPermissionModes, fetchOrgPolicy, type OrgPolicy } from "./api/org-settings.js"
import { getOrgPolicy, getOrgPolicyOrgId, initOrgPolicy, resetOrgPolicyForTests } from "./org-policy.js"

vi.mock("./config.js", () => ({
	resolveEndpoints: () => ({ platformApiUrl: "https://api.test" }),
}))

function cachePathFor(test: { cachePath?: string }): string {
	if (!test.cachePath) test.cachePath = join(mkdtempSync(join(tmpdir(), "org-policy-")), "org-policy.json")
	return test.cachePath
}

function readCacheFile(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
}

vi.mock("./api/org-settings.js", async (importOriginal) => ({
	// Keep the real module (parseOrgPolicy helpers) and only replace the fetch:
	// cache validation must exercise the genuine parse logic, not a mock.
	...(await importOriginal<typeof import("./api/org-settings.js")>()),
	fetchOrgPolicy: vi.fn(),
}))

const mockedFetchOrgPolicy = vi.mocked(fetchOrgPolicy)

const PLAN_ONLY: AllowedPermissionModes = { plan: true, default: false, auto: false, yolo: false }
const DEFAULT_ONLY: AllowedPermissionModes = { plan: false, default: true, auto: false, yolo: false }

function resolveWithPolicy(orgId: string, policy: OrgPolicy | undefined) {
	mockedFetchOrgPolicy.mockResolvedValue({ kind: "policy", orgId, policy })
}

afterEach(() => {
	resetOrgPolicyForTests()
	mockedFetchOrgPolicy.mockReset()
})

describe("initOrgPolicy", () => {
	it("fetches and stores the policy on a cache miss", async () => {
		const cachePath = cachePathFor({})
		resolveWithPolicy("org-1", { allowedPermissionModes: PLAN_ONLY, usageReporting: "FORCE_ON" })

		await initOrgPolicy("key-1", { cachePath })

		expect(getOrgPolicy()).toEqual({ allowedPermissionModes: PLAN_ONLY, usageReporting: "FORCE_ON" })
		expect(getOrgPolicyOrgId()).toBe("org-1")

		const cached = readCacheFile(cachePath)
		expect(cached.orgId).toBe("org-1")
		expect(cached.policy).toEqual({ allowedPermissionModes: PLAN_ONLY, usageReporting: "FORCE_ON" })
		// The key is never stored in plaintext.
		expect(JSON.stringify(cached)).not.toContain("key-1")
	})

	it("stores an absent policy and overwrites a stale cached one", async () => {
		const cachePath = cachePathFor({})
		writeFileSync(
			cachePath,
			`${JSON.stringify({ keyFingerprint: "fingerprint-of-key-1", orgId: "org-1", fetchedAt: 1, policy: { allowedPermissionModes: { plan: false, default: false, auto: false, yolo: true } } })}\n`,
		)

		// Different key: cache miss, fetch returns "no policy at all".
		resolveWithPolicy("org-1", undefined)

		await initOrgPolicy("key-2", { cachePath })

		expect(getOrgPolicy()).toBeUndefined()
		const cached = readCacheFile(cachePath)
		expect(cached.policy).toBeUndefined()
	})

	it("overwrites a stale or locally edited cache with the fresh resolution before it is read", async () => {
		const cachePath = cachePathFor({})
		const { createHash } = await import("node:crypto")
		const fingerprint = createHash("sha256").update("key-1").digest("hex")
		// A cache edited by hand to lock a resource the org never restricted.
		writeFileSync(
			cachePath,
			`${JSON.stringify({ keyFingerprint: fingerprint, orgId: "org-1", fetchedAt: 1, policy: { allowedPermissionModes: PLAN_ONLY, resources: { "tools.web_search": "FORCE_OFF" } } })}\n`,
		)

		// The platform's current answer differs: it wins immediately, and the
		// cache file is rewritten in the same startup — the edited lock never
		// applies to this or any later session.
		resolveWithPolicy("org-1", { allowedPermissionModes: DEFAULT_ONLY, usageReporting: "FORCE_OFF" })

		await initOrgPolicy("key-1", { cachePath })

		expect(getOrgPolicy()).toEqual({ allowedPermissionModes: DEFAULT_ONLY, usageReporting: "FORCE_OFF" })
		expect(getOrgPolicyOrgId()).toBe("org-1")
		expect(readCacheFile(cachePath).policy).toEqual({
			allowedPermissionModes: DEFAULT_ONLY,
			usageReporting: "FORCE_OFF",
		})
	})

	it("drops corrupted cached policy values instead of imposing them", async () => {
		const cachePath = cachePathFor({})
		const { createHash } = await import("node:crypto")
		const fingerprint = createHash("sha256").update("key-1").digest("hex")
		writeFileSync(
			cachePath,
			`${JSON.stringify({ keyFingerprint: fingerprint, orgId: "org-1", fetchedAt: 1, policy: { allowedPermissionModes: { plan: "yes", auto: 1 }, usageReporting: "SURE" } })}\n`,
		)

		// No fresh answer: the fallback reads the cache through
		// validateCachedPolicy, so the corrupted values cannot impose anything.
		mockedFetchOrgPolicy.mockResolvedValue({ kind: "unreachable" })

		await initOrgPolicy("key-1", { cachePath })

		expect(getOrgPolicy()).toBeUndefined()
	})

	it("falls back to the cached policy when policy resolution is denied", async () => {
		const cachePath = cachePathFor({})
		resolveWithPolicy("org-1", { allowedPermissionModes: PLAN_ONLY })
		await initOrgPolicy("key-1", { cachePath })
		expect(getOrgPolicy()).toEqual({ allowedPermissionModes: PLAN_ONLY })

		// Policy resolution is denied (403/404) without a verdict on the key:
		// no fresh answer, so the session falls back to the cached policy and
		// the cache file is left untouched.
		mockedFetchOrgPolicy.mockResolvedValue({ kind: "no-access" })
		await initOrgPolicy("key-1", { cachePath })

		expect(getOrgPolicy()).toEqual({ allowedPermissionModes: PLAN_ONLY })
		expect(getOrgPolicyOrgId()).toBe("org-1")
		expect(readCacheFile(cachePath).policy).toEqual({ allowedPermissionModes: PLAN_ONLY })
	})

	it("clears the holder and wipes the cache when the key itself is rejected", async () => {
		const cachePath = cachePathFor({})
		resolveWithPolicy("org-1", { allowedPermissionModes: PLAN_ONLY })
		await initOrgPolicy("key-1", { cachePath })
		expect(getOrgPolicy()).toEqual({ allowedPermissionModes: PLAN_ONLY })

		// The key stopped verifying (401): a cached policy for it can never
		// revalidate, so both the session and this key's cache start
		// unrestricted (fail open, scoped to this key).
		mockedFetchOrgPolicy.mockResolvedValue({ kind: "revoked" })
		await initOrgPolicy("key-1", { cachePath })

		expect(getOrgPolicy()).toBeUndefined()
		expect(() => readCacheFile(cachePath)).toThrow()
	})

	it("keeps another key's cached policy when this key is rejected", async () => {
		const cachePath = cachePathFor({})
		writeFileSync(
			cachePath,
			`${JSON.stringify({ keyFingerprint: "fingerprint-of-another-key", orgId: "org-1", fetchedAt: 1, policy: { allowedPermissionModes: PLAN_ONLY } })}\n`,
		)

		// key-1 has no usable cache (fingerprint mismatch → cold path) and its
		// fetch is rejected: the wipe must not drop the other key's cache.
		mockedFetchOrgPolicy.mockResolvedValue({ kind: "revoked" })
		await initOrgPolicy("key-1", { cachePath })

		expect(getOrgPolicy()).toBeUndefined()
		expect(readCacheFile(cachePath).policy).toEqual({ allowedPermissionModes: PLAN_ONLY })
	})

	it("keeps the last known good policy when the platform is unreachable", async () => {
		const cachePath = cachePathFor({})
		resolveWithPolicy("org-1", { allowedPermissionModes: PLAN_ONLY })
		await initOrgPolicy("key-1", { cachePath })

		// Offline: the session falls back to the cached policy and the cache
		// file is left untouched.
		mockedFetchOrgPolicy.mockResolvedValue({ kind: "unreachable" })
		await initOrgPolicy("key-1", { cachePath })

		expect(getOrgPolicy()).toEqual({ allowedPermissionModes: PLAN_ONLY })
		expect(readCacheFile(cachePath).policy).toEqual({ allowedPermissionModes: PLAN_ONLY })
	})

	it("fetches, stores, and caches the resources map", async () => {
		const cachePath = cachePathFor({})
		const policy: OrgPolicy = { resources: { "tools.web_search": "FORCE_OFF", "future.resource": "ON" } }
		resolveWithPolicy("org-1", policy)

		await initOrgPolicy("key-1", { cachePath })

		expect(getOrgPolicy()).toEqual(policy)
		expect(readCacheFile(cachePath).policy).toEqual(policy)
	})

	it("drops corrupted cached resource values, keeping valid ones", async () => {
		const cachePath = cachePathFor({})
		const { createHash } = await import("node:crypto")
		const fingerprint = createHash("sha256").update("key-1").digest("hex")
		writeFileSync(
			cachePath,
			`${JSON.stringify({
				keyFingerprint: fingerprint,
				orgId: "org-1",
				fetchedAt: 1,
				policy: {
					resources: {
						"tools.web_search": "FORCE_OFF",
						"extensions.memory": "WHATEVER",
						"extensions.agents": true,
					},
				},
			})}\n`,
		)

		// No fresh answer: the fallback validates the cache the same way the
		// wire parser would.
		mockedFetchOrgPolicy.mockResolvedValue({ kind: "unreachable" })

		await initOrgPolicy("key-1", { cachePath })

		expect(getOrgPolicy()).toEqual({ resources: { "tools.web_search": "FORCE_OFF" } })
	})

	it("treats a cached policy with only invalid resources as absent", async () => {
		const cachePath = cachePathFor({})
		const { createHash } = await import("node:crypto")
		const fingerprint = createHash("sha256").update("key-1").digest("hex")
		writeFileSync(
			cachePath,
			`${JSON.stringify({
				keyFingerprint: fingerprint,
				orgId: "org-1",
				fetchedAt: 1,
				policy: { resources: { "tools.web_search": "NOPE" } },
			})}\n`,
		)

		mockedFetchOrgPolicy.mockResolvedValue({ kind: "unreachable" })

		await initOrgPolicy("key-1", { cachePath })

		expect(getOrgPolicy()).toBeUndefined()
	})

	it("clears the holder without an API key but keeps the cache file warm", async () => {
		const cachePath = cachePathFor({})
		resolveWithPolicy("org-1", { allowedPermissionModes: PLAN_ONLY })
		await initOrgPolicy("key-1", { cachePath })

		const callsBefore = mockedFetchOrgPolicy.mock.calls.length
		await initOrgPolicy("", { cachePath })

		expect(mockedFetchOrgPolicy.mock.calls.length).toBe(callsBefore)
		expect(getOrgPolicy()).toBeUndefined()
		// The cache survives so the next keyed run starts warm.
		expect(readCacheFile(cachePath).policy).toEqual({ allowedPermissionModes: PLAN_ONLY })
	})
})

describe("cache file cleanup", () => {
	it("tolerates a missing cache directory", async () => {
		const dir = join(mkdtempSync(join(tmpdir(), "org-policy-")), "does", "not", "exist")
		const cachePath = join(dir, "org-policy.json")
		resolveWithPolicy("org-1", undefined)

		await expect(initOrgPolicy("key-1", { cachePath })).resolves.toBeUndefined()
		expect(getOrgPolicy()).toBeUndefined()

		rmSync(dir, { recursive: true, force: true })
	})
})
