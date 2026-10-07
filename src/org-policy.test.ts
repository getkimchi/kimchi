import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { fetchOrgPolicy, type OrgPolicy } from "./api/org-settings.js"
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

function fakeFetch(): typeof globalThis.fetch {
	return vi.fn(async () => {
		throw new Error("network calls must go through the mocked fetchOrgPolicy")
	}) as unknown as typeof globalThis.fetch
}

vi.mock("./api/org-settings.js", () => ({
	fetchOrgPolicy: vi.fn(),
}))

const mockedFetchOrgPolicy = vi.mocked(fetchOrgPolicy)

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
		resolveWithPolicy("org-1", { maxPermissionMode: "PLAN", usageReporting: "FORCE_ON" })

		await initOrgPolicy("key-1", { cachePath, fetch: fakeFetch() })

		expect(getOrgPolicy()).toEqual({ maxPermissionMode: "PLAN", usageReporting: "FORCE_ON" })
		expect(getOrgPolicyOrgId()).toBe("org-1")

		const cached = readCacheFile(cachePath)
		expect(cached.orgId).toBe("org-1")
		expect(cached.policy).toEqual({ maxPermissionMode: "PLAN", usageReporting: "FORCE_ON" })
		// The key is never stored in plaintext.
		expect(JSON.stringify(cached)).not.toContain("key-1")
	})

	it("stores an absent policy and overwrites a stale cached one", async () => {
		const cachePath = cachePathFor({})
		writeFileSync(
			cachePath,
			`${JSON.stringify({ keyFingerprint: "fingerprint-of-key-1", orgId: "org-1", fetchedAt: 1, policy: { maxPermissionMode: "YOLO" } })}\n`,
		)

		// Different key: cache miss, fetch returns "no policy at all".
		resolveWithPolicy("org-1", undefined)

		await initOrgPolicy("key-2", { cachePath, fetch: fakeFetch() })

		expect(getOrgPolicy()).toBeUndefined()
		const cached = readCacheFile(cachePath)
		expect(cached.policy).toBeUndefined()
	})

	it("applies the cached policy for the same key and refreshes in the background", async () => {
		const cachePath = cachePathFor({})
		const { createHash } = await import("node:crypto")
		const fingerprint = createHash("sha256").update("key-1").digest("hex")
		writeFileSync(
			cachePath,
			`${JSON.stringify({ keyFingerprint: fingerprint, orgId: "org-1", fetchedAt: 1, policy: { maxPermissionMode: "PLAN" } })}\n`,
		)

		// Background refresh returns a stricter policy; it must land in the cache.
		resolveWithPolicy("org-1", { maxPermissionMode: "DEFAULT", usageReporting: "FORCE_OFF" })

		const promise = initOrgPolicy("key-1", { cachePath, fetch: fakeFetch() })

		// The cached value applies synchronously, before the refresh completes.
		expect(getOrgPolicy()).toEqual({ maxPermissionMode: "PLAN" })

		await promise
		expect(getOrgPolicy()).toEqual({ maxPermissionMode: "DEFAULT", usageReporting: "FORCE_OFF" })
		expect(readCacheFile(cachePath).policy).toEqual({ maxPermissionMode: "DEFAULT", usageReporting: "FORCE_OFF" })

		// The awaited promise resolves before the background refresh finishes;
		// drain it (it is the first mock call in this test) so it cannot leak
		// into the next test.
		await vi.waitFor(() => expect(mockedFetchOrgPolicy.mock.calls.length).toBeGreaterThanOrEqual(1))
	})

	it("clears state and cache on auth failure", async () => {
		const cachePath = cachePathFor({})
		resolveWithPolicy("org-1", { maxPermissionMode: "PLAN" })
		await initOrgPolicy("key-1", { cachePath, fetch: fakeFetch() })
		expect(getOrgPolicy()).toEqual({ maxPermissionMode: "PLAN" })

		mockedFetchOrgPolicy.mockResolvedValue({ kind: "no-access" })
		await initOrgPolicy("key-1", { cachePath, fetch: fakeFetch() })

		// Drain the background refresh launched by the cache hit above.
		await vi.waitFor(() => expect(mockedFetchOrgPolicy.mock.calls.length).toBeGreaterThanOrEqual(2))

		expect(getOrgPolicy()).toBeUndefined()
		expect(getOrgPolicyOrgId()).toBeUndefined()
		expect(() => readCacheFile(cachePath)).toThrow()
	})

	it("keeps the last known good policy when the platform is unreachable", async () => {
		const cachePath = cachePathFor({})
		resolveWithPolicy("org-1", { maxPermissionMode: "PLAN" })
		await initOrgPolicy("key-1", { cachePath, fetch: fakeFetch() })

		mockedFetchOrgPolicy.mockResolvedValue({ kind: "unreachable" })
		await initOrgPolicy("key-1", { cachePath, fetch: fakeFetch() })

		expect(getOrgPolicy()).toEqual({ maxPermissionMode: "PLAN" })
		expect(readCacheFile(cachePath).policy).toEqual({ maxPermissionMode: "PLAN" })

		// The cache-miss path above is followed by a background refresh (the
		// cache now matches); drain it so it cannot leak into the next test.
		await vi.waitFor(() => expect(mockedFetchOrgPolicy.mock.calls.length).toBeGreaterThanOrEqual(2))
	})

	it("does nothing without an API key", async () => {
		const cachePath = cachePathFor({})
		resolveWithPolicy("org-1", { maxPermissionMode: "PLAN" })
		await initOrgPolicy("key-1", { cachePath, fetch: fakeFetch() })

		const callsBefore = mockedFetchOrgPolicy.mock.calls.length
		await initOrgPolicy("", { cachePath, fetch: fakeFetch() })

		expect(mockedFetchOrgPolicy.mock.calls.length).toBe(callsBefore)
		expect(getOrgPolicy()).toBeUndefined()
		expect(() => readCacheFile(cachePath)).toThrow()
	})
})

describe("cache file cleanup", () => {
	it("tolerates a missing cache directory", async () => {
		const dir = join(mkdtempSync(join(tmpdir(), "org-policy-")), "does", "not", "exist")
		const cachePath = join(dir, "org-policy.json")
		resolveWithPolicy("org-1", undefined)

		await expect(initOrgPolicy("key-1", { cachePath, fetch: fakeFetch() })).resolves.toBeUndefined()
		expect(getOrgPolicy()).toBeUndefined()

		rmSync(dir, { recursive: true, force: true })
	})
})
