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

vi.mock("./api/org-settings.js", () => ({
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

	it("keeps the session policy stable while the background refresh updates only the cache", async () => {
		const cachePath = cachePathFor({})
		const { createHash } = await import("node:crypto")
		const fingerprint = createHash("sha256").update("key-1").digest("hex")
		writeFileSync(
			cachePath,
			`${JSON.stringify({ keyFingerprint: fingerprint, orgId: "org-1", fetchedAt: 1, policy: { allowedPermissionModes: PLAN_ONLY } })}\n`,
		)

		// The background refresh returns a stricter policy: it must land in the
		// cache but NOT change the in-session holder.
		resolveWithPolicy("org-1", { allowedPermissionModes: DEFAULT_ONLY, usageReporting: "FORCE_OFF" })

		await initOrgPolicy("key-1", { cachePath })

		// The cached value applies for the whole session...
		expect(getOrgPolicy()).toEqual({ allowedPermissionModes: PLAN_ONLY })

		// ...and the refresh has settled into the cache file only.
		await vi.waitFor(() => expect(mockedFetchOrgPolicy.mock.calls.length).toBeGreaterThanOrEqual(1))
		expect(getOrgPolicy()).toEqual({ allowedPermissionModes: PLAN_ONLY })
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

		await initOrgPolicy("key-1", { cachePath })

		expect(getOrgPolicy()).toBeUndefined()
	})

	it("clears the cache on auth failure; the session keeps its policy until relaunch", async () => {
		const cachePath = cachePathFor({})
		resolveWithPolicy("org-1", { allowedPermissionModes: PLAN_ONLY })
		await initOrgPolicy("key-1", { cachePath })
		expect(getOrgPolicy()).toEqual({ allowedPermissionModes: PLAN_ONLY })

		// The key stopped verifying: the cache is cleared (next launch starts
		// unrestricted), but this session keeps the policy it started with.
		mockedFetchOrgPolicy.mockResolvedValue({ kind: "no-access" })
		await initOrgPolicy("key-1", { cachePath })

		// Drain the background refresh launched by the cache hit above.
		await vi.waitFor(() => expect(mockedFetchOrgPolicy.mock.calls.length).toBeGreaterThanOrEqual(2))

		expect(getOrgPolicy()).toEqual({ allowedPermissionModes: PLAN_ONLY })
		expect(getOrgPolicyOrgId()).toBe("org-1")
		expect(() => readCacheFile(cachePath)).toThrow()
	})

	it("keeps the last known good policy when the platform is unreachable", async () => {
		const cachePath = cachePathFor({})
		resolveWithPolicy("org-1", { allowedPermissionModes: PLAN_ONLY })
		await initOrgPolicy("key-1", { cachePath })

		mockedFetchOrgPolicy.mockResolvedValue({ kind: "unreachable" })
		await initOrgPolicy("key-1", { cachePath })

		// Drain the background refresh launched by the cache hit above.
		await vi.waitFor(() => expect(mockedFetchOrgPolicy.mock.calls.length).toBeGreaterThanOrEqual(2))

		expect(getOrgPolicy()).toEqual({ allowedPermissionModes: PLAN_ONLY })
		expect(readCacheFile(cachePath).policy).toEqual({ allowedPermissionModes: PLAN_ONLY })
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
