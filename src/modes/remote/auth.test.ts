import { describe, expect, it, vi } from "vitest"
import { authenticateRemoteSession } from "./auth.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"

const BASE = "https://api.example.com"

function mockFetch(url: string, opts: RequestInit): ReturnType<typeof globalThis.fetch>
function mockFetch(...args: unknown[]): never {
	throw new Error(`Unexpected fetch: ${args[0]}`)
}

describe("authenticateRemoteSession", () => {
	it("returns AuthenticateResponse on success after the 3-step flow", async () => {
		const mockFetch = vi
			.fn()
			// Step 1: verifyApiKey
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-516442fe-054a-49e2-ac2d-9dc9b104c3d2" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			// Step 2: createOrUpdateSession
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						createTime: "2026-05-15T12:41:40.295Z",
						id: "sess-123",
						organizationId: "org-516442fe-054a-49e2-ac2d-9dc9b104c3d2",
						status: "INITIALIZING",
						uri: "wss://s-3380b7aa-981b-4272-8f7d-d6e41f62139f.remote.kimchi.dev",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			// Step 3: exchangeSessionToken
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						token: "jwt-token-abc",
						expireTime: "2026-05-15T12:44:51.521Z",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)

		const result = await authenticateRemoteSession("sess-123", "key1", {
			endpoint: BASE,
			fetch: mockFetch,
		})

		expect(result.connectToken).toBe("jwt-token-abc")
		expect(result.expiresAt).toBe("2026-05-15T12:44:51.521Z")
		expect(result.wsUrl).toBe("wss://s-3380b7aa-981b-4272-8f7d-d6e41f62139f.remote.kimchi.dev")

		expect(mockFetch).toHaveBeenCalledTimes(3)
		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/api/ai-optimizer/v1beta/api-keys:verify`)
		expect(mockFetch.mock.calls[0][1]).toMatchObject({
			method: "POST",
			headers: expect.objectContaining({
				Authorization: "Bearer key1",
				"Content-Type": "application/json",
			}),
		})
		expect(mockFetch.mock.calls[1][0]).toBe(
			`${BASE}/api/ai-optimizer/v1beta/organizations/org-516442fe-054a-49e2-ac2d-9dc9b104c3d2/sessions/sess-123`,
		)
		expect(mockFetch.mock.calls[1][1]).toMatchObject({
			method: "PUT",
			headers: expect.objectContaining({
				Authorization: "Bearer key1",
				"Content-Type": "application/json",
			}),
		})
		expect(mockFetch.mock.calls[2][0]).toBe(`${BASE}/api/ai-optimizer/v1beta/session-tokens:exchange`)
		expect(mockFetch.mock.calls[2][1]).toMatchObject({
			method: "POST",
			headers: expect.objectContaining({
				Authorization: "Bearer key1",
			}),
			body: JSON.stringify({ sessionId: "sess-123" }),
		})
	})

	it("uses explicit endpoint override for all steps", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ uri: "wss://override.ws" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ token: "t", expireTime: "2025-01-01T00:00:00Z" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)

		await authenticateRemoteSession("s1", "key1", { endpoint: "https://override.example.com", fetch: mockFetch })
		for (const call of mockFetch.mock.calls) {
			const url = call[0] as string
			expect(url.startsWith("https://override.example.com/")).toBe(true)
		}
	})

	it("throws RemoteAuthError for 401 on verify", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
		await expect(authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteAuthError,
		)
	})

	it("throws RemoteAuthError for 401 on create session", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 401 }))

		await expect(authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteAuthError,
		)
	})

	it("throws RemoteAuthError for 401 on exchange token", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ uri: "wss://x.ws" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 401 }))

		await expect(authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteAuthError,
		)
	})

	it("throws RemoteAuthError for 403", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))
		await expect(authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteAuthError,
		)
	})

	it("throws RemoteAuthError for 404", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
		await expect(authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteAuthError,
		)
	})

	it("throws RemoteAuthError for 409", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 409 }))
		await expect(authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteAuthError,
		)
	})

	it("throws RemoteNetworkError for other HTTP status", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
		await expect(authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
	})

	it("throws RemoteNetworkError on fetch failure", async () => {
		const mockFetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"))
		await expect(authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
	})

	it("throws RemoteNetworkError when verify response is missing organizationId", async () => {
		const mockFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)

		await expect(authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
	})

	it("throws RemoteNetworkError when session response is missing uri", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "sess-123" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)

		await expect(authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
	})

	it("throws RemoteNetworkError when exchange response is missing token", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ uri: "wss://x.ws" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ expireTime: "2025-01-01T00:00:00Z" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)

		await expect(authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
	})
})
