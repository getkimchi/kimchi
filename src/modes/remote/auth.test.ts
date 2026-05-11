import { describe, expect, it, vi } from "vitest"
import { authenticateRemoteSession } from "./auth.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"

describe("authenticateRemoteSession", () => {
	it("returns AuthenticateResponse on success", async () => {
		const mockFetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					connectToken: "token123",
					expiresAt: "2025-01-01T00:00:00Z",
					wsUrl: "wss://llm.kimchi.dev/sessions/s1",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		)

		const result = await authenticateRemoteSession("s1", "key1", {
			endpoint: "https://api.example.com",
			fetch: mockFetch,
		})

		expect(result.connectToken).toBe("token123")
		expect(result.wsUrl).toBe("wss://llm.kimchi.dev/sessions/s1")
		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.example.com/v1/remote-sessions/s1:authenticate",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer key1",
					"Content-Type": "application/json",
				}),
			}),
		)
	})

	it("throws RemoteAuthError for 401", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))

		await expect(authenticateRemoteSession("s1", "key1", { fetch: mockFetch })).rejects.toBeInstanceOf(RemoteAuthError)

		try {
			await authenticateRemoteSession("s1", "key1", { fetch: mockFetch })
		} catch (e) {
			expect((e as RemoteAuthError).statusCode).toBe(401)
			expect((e as Error).message).toMatch(/Invalid API key/)
		}
	})

	it("throws RemoteAuthError for 403", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))

		await expect(authenticateRemoteSession("s1", "key1", { fetch: mockFetch })).rejects.toBeInstanceOf(RemoteAuthError)
	})

	it("throws RemoteAuthError for 404", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))

		await expect(authenticateRemoteSession("s1", "key1", { fetch: mockFetch })).rejects.toBeInstanceOf(RemoteAuthError)
	})

	it("throws RemoteAuthError for 409", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 409 }))

		await expect(authenticateRemoteSession("s1", "key1", { fetch: mockFetch })).rejects.toBeInstanceOf(RemoteAuthError)
	})

	it("throws RemoteNetworkError for other HTTP status", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))

		await expect(authenticateRemoteSession("s1", "key1", { fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
	})

	it("throws RemoteNetworkError on fetch failure", async () => {
		const mockFetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"))

		await expect(authenticateRemoteSession("s1", "key1", { fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
	})

	it("uses explicit endpoint override", async () => {
		const mockFetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					connectToken: "t",
					expiresAt: "2025-01-01T00:00:00Z",
					wsUrl: "wss://override.example.com/ws",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		)

		await authenticateRemoteSession("s1", "key1", { endpoint: "https://override.example.com", fetch: mockFetch })
		expect(mockFetch).toHaveBeenCalledWith(
			"https://override.example.com/v1/remote-sessions/s1:authenticate",
			expect.anything(),
		)
	})
})
