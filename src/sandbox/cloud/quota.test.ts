import { describe, expect, it, vi } from "vitest"
import { getQuotaUsage } from "./quota.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"

const BASE = "https://api.example.com"
const ORG_ID = "org-516442fe-054a-49e2-ac2d-9dc9b104c3d2"
const QUOTA_URL = `${BASE}/ai-optimizer/v1beta/organizations/${ORG_ID}/quotas:usage`

function verifyResponse() {
	return new Response(JSON.stringify({ organizationId: ORG_ID }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	})
}

function quotaResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function usageFixture(over: Partial<Record<string, unknown>> = {}) {
	// currentSandboxes/maxSandboxes are int32 (arrive as numbers);
	// cpu/ram fields are int64 (gRPC-gateway emits JSON strings).
	return {
		currentSandboxes: 3,
		maxSandboxes: 10,
		currentCpuMillicores: "4500",
		maxCpuMillicores: "16000",
		currentRamBytes: "6442450944",
		maxRamBytes: "17179869184",
		currentPvcSizeBytes: "21474836480",
		maxPvcSizeBytes: "128849018880",
		...over,
	}
}

describe("getQuotaUsage", () => {
	it("parses orgUsage and userUsage, normalizing string int64s to numbers", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(
				quotaResponse({
					orgUsage: usageFixture({ currentSandboxes: 7, currentCpuMillicores: "9000" }),
					userUsage: usageFixture(),
				}),
			)

		const usage = await getQuotaUsage("key1", { endpoint: BASE, fetch: mockFetch })

		expect(usage.userUsage).toEqual({
			currentSandboxes: 3,
			maxSandboxes: 10,
			currentCpuMillicores: 4500,
			maxCpuMillicores: 16000,
			currentRamBytes: 6442450944,
			maxRamBytes: 17179869184,
			currentPvcSizeBytes: 21474836480,
			maxPvcSizeBytes: 128849018880,
		})
		expect(usage.orgUsage).toMatchObject({ currentSandboxes: 7, currentCpuMillicores: 9000 })
	})

	it("accepts plain-number int64 fields", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(
				quotaResponse({
					orgUsage: usageFixture({
						currentCpuMillicores: 1000,
						maxCpuMillicores: 4000,
						currentRamBytes: 4294967296,
						maxRamBytes: 8589934592,
					}),
					userUsage: usageFixture(),
				}),
			)

		const usage = await getQuotaUsage("key1", { endpoint: BASE, fetch: mockFetch })

		expect(usage.orgUsage).toMatchObject({
			currentCpuMillicores: 1000,
			maxCpuMillicores: 4000,
			currentRamBytes: 4294967296,
			maxRamBytes: 8589934592,
		})
	})

	it("sends bearer auth to the quotas:usage route after key verification", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(quotaResponse({ orgUsage: usageFixture(), userUsage: usageFixture() }))

		await getQuotaUsage("key1", { endpoint: BASE, fetch: mockFetch })

		expect(mockFetch).toHaveBeenCalledTimes(2)
		expect(mockFetch.mock.calls[1][0]).toBe(QUOTA_URL)
		expect(mockFetch.mock.calls[1][1]).toMatchObject({
			method: "GET",
			headers: expect.objectContaining({
				Authorization: "Bearer key1",
				Accept: "application/json",
			}),
		})
	})

	it("returns undefined scopes when the response omits them", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(quotaResponse({ userUsage: usageFixture() }))

		const usage = await getQuotaUsage("key1", { endpoint: BASE, fetch: mockFetch })

		expect(usage.orgUsage).toBeUndefined()
		expect(usage.userUsage).toBeDefined()
	})

	it("leaves individual fields undefined when the scope is partial (older control planes)", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(
				quotaResponse({
					userUsage: { currentSandboxes: 1, maxSandboxes: 5, currentCpuMillicores: "garbage" },
				}),
			)

		const usage = await getQuotaUsage("key1", { endpoint: BASE, fetch: mockFetch })

		expect(usage.userUsage).toMatchObject({ currentSandboxes: 1, maxSandboxes: 5 })
		expect(usage.userUsage?.currentCpuMillicores).toBeUndefined()
		expect(usage.userUsage?.maxCpuMillicores).toBeUndefined()
		expect(usage.userUsage?.currentRamBytes).toBeUndefined()
	})

	it("skips key verification when a pre-resolved orgId is provided", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(quotaResponse({ userUsage: usageFixture() }))
		const usage = await getQuotaUsage("key1", { endpoint: BASE, fetch: mockFetch, orgId: ORG_ID })
		expect(mockFetch).toHaveBeenCalledTimes(1)
		expect(mockFetch.mock.calls[0][0]).toBe(QUOTA_URL)
		expect(usage.userUsage).toBeDefined()
	})

	it("throws RemoteAuthError on 401", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
		await expect(getQuotaUsage("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(RemoteAuthError)
	})

	it("throws RemoteNetworkError on 500", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(new Response(null, { status: 500 }))
		await expect(getQuotaUsage("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(RemoteNetworkError)
	})

	it("wraps low-level fetch failures as RemoteNetworkError", async () => {
		const mockFetch = vi.fn().mockImplementation((url: string) => {
			if (typeof url === "string" && url.endsWith("/workspace-tokens:verifyKey")) {
				return Promise.resolve(verifyResponse())
			}
			return Promise.reject(new TypeError("fetch failed"))
		})
		await expect(getQuotaUsage("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(RemoteNetworkError)
	})

	it("throws RemoteNetworkError on non-JSON response", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(new Response("not json", { status: 200 }))
		await expect(getQuotaUsage("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(RemoteNetworkError)
	})
})
