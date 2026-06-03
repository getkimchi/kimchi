import { describe, expect, it, vi } from "vitest"
import { verifyApiKey } from "./keys.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"

const BASE = "https://api.example.com"

describe("verifyApiKey", () => {
	it("POSTs to api-keys:verify and returns organizationId", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify({ organizationId: "org-42" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)

		const orgId = await verifyApiKey("key1", { endpoint: BASE, fetch: mockFetch })

		expect(orgId).toBe("org-42")
		expect(mockFetch).toHaveBeenCalledTimes(1)
		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/ai-optimizer/v1beta/api-keys:verify`)
		expect(mockFetch.mock.calls[0][1]).toMatchObject({
			method: "POST",
			headers: expect.objectContaining({
				Authorization: "Bearer key1",
				"Content-Type": "application/json",
			}),
		})
	})

	it("throws RemoteAuthError on 401", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
		await expect(verifyApiKey("bad", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(RemoteAuthError)
	})

	it("throws RemoteNetworkError when organizationId is missing", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify({}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)
		await expect(verifyApiKey("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(RemoteNetworkError)
	})
})
