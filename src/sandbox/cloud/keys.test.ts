import { describe, expect, it, vi } from "vitest"
import { verifyApiKey } from "./keys.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"

const BASE = "https://api.example.com"

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	})
}

describe("verifyApiKey", () => {
	it("POSTs to workspace-tokens:verifyKey and returns organizationId + userId", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ organizationId: "org-42", userId: "user-7" }))

		const verified = await verifyApiKey("key1", { endpoint: BASE, fetch: mockFetch })

		expect(verified).toEqual({ organizationId: "org-42", userId: "user-7" })
		expect(mockFetch).toHaveBeenCalledTimes(1)
		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/ai-optimizer/v1beta/workspace-tokens:verifyKey`)
		expect(mockFetch.mock.calls[0][1]).toMatchObject({
			method: "POST",
			headers: expect.objectContaining({
				Authorization: "Bearer key1",
				"Content-Type": "application/json",
			}),
		})
	})

	it("returns an undefined userId when the verify response omits it (enforced at point of use)", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ organizationId: "org-42" }))
		const verified = await verifyApiKey("key1", { endpoint: BASE, fetch: mockFetch })
		expect(verified).toEqual({ organizationId: "org-42", userId: undefined })
	})

	it("throws RemoteAuthError on 401", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
		await expect(verifyApiKey("bad", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(RemoteAuthError)
	})

	it("throws RemoteNetworkError when organizationId is missing", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ userId: "user-7" }))
		await expect(verifyApiKey("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(RemoteNetworkError)
	})
})
