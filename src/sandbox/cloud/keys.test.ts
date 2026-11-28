import { describe, expect, it, vi } from "vitest"
import { verifyApiKey } from "./keys.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"

const BASE = "https://api.example.com"
const KEY = { token: "key1" }
const SSO = { token: "tok", organizationId: "org-a" }
const ORG_HEADER = "X-CastAi-Organization-Id"

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	})
}

describe("verifyApiKey", () => {
	it("POSTs to workspace-tokens:verifyKey and returns organizationId + userId", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ organizationId: "org-42", userId: "user-7" }))

		const verified = await verifyApiKey(KEY, { endpoint: BASE, fetch: mockFetch })

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
		const verified = await verifyApiKey(KEY, { endpoint: BASE, fetch: mockFetch })
		expect(verified).toEqual({ organizationId: "org-42", userId: undefined })
	})

	it("sends the SSO org header on verifyKey", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ organizationId: "org-a", userId: "user-7" }))

		await verifyApiKey(SSO, { endpoint: BASE, fetch: mockFetch })

		expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
			Authorization: "Bearer tok",
			[ORG_HEADER]: "org-a",
		})
	})

	it("sends no org header for an API key", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ organizationId: "org-42", userId: "user-7" }))

		await verifyApiKey(KEY, { endpoint: BASE, fetch: mockFetch })

		expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty(ORG_HEADER)
	})

	it("throws RemoteAuthError on 401", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
		await expect(verifyApiKey({ token: "bad" }, { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteAuthError,
		)
	})

	it("throws RemoteNetworkError when organizationId is missing", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ userId: "user-7" }))
		await expect(verifyApiKey(KEY, { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(RemoteNetworkError)
	})
})
