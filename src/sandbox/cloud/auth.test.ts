import { describe, expect, it, vi } from "vitest"
import { authenticateWorkspace } from "./auth.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"

const BASE = "https://api.example.com"

function mockAuthFlow(uri: string) {
	return vi
		.fn()
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ organizationId: "org-1" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ uri }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ token: "jwt-tok", expireTime: "2026-01-01T00:00:00Z" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)
}

describe("authenticateWorkspace", () => {
	it("returns WorkspaceCredentials after the 3-step flow with correct URLs and methods", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-516442fe-054a-49e2-ac2d-9dc9b104c3d2" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						createTime: "2026-05-15T12:41:40.295Z",
						id: "ws-123",
						organizationId: "org-516442fe-054a-49e2-ac2d-9dc9b104c3d2",
						status: "INITIALIZING",
						uri: "wss://s-3380b7aa.remote.kimchi.dev",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ token: "jwt-token-abc", expireTime: "2026-05-15T12:44:51.521Z" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)

		const result = await authenticateWorkspace("ws-123", "key1", "test workspace", {
			endpoint: BASE,
			fetch: mockFetch,
		})

		expect(result.connectToken).toBe("jwt-token-abc")
		expect(result.expiresAt).toBe("2026-05-15T12:44:51.521Z")
		expect(result.wsUrl).toBe("wss://s-3380b7aa.remote.kimchi.dev")
		expect(result.host).toBe("s-3380b7aa.remote.kimchi.dev")
		// WorkspaceCredentials must not carry `description`.
		expect((result as unknown as { description?: string }).description).toBeUndefined()

		expect(mockFetch).toHaveBeenCalledTimes(3)
		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/ai-optimizer/v1beta/api-keys:verify`)
		expect(mockFetch.mock.calls[1][0]).toBe(
			`${BASE}/ai-optimizer/v1beta/organizations/org-516442fe-054a-49e2-ac2d-9dc9b104c3d2/sessions/ws-123`,
		)
		expect(mockFetch.mock.calls[1][1]).toMatchObject({ method: "PUT" })
		expect(mockFetch.mock.calls[2][0]).toBe(`${BASE}/ai-optimizer/v1beta/session-tokens:exchange`)
		expect(mockFetch.mock.calls[2][1]).toMatchObject({
			method: "POST",
			body: JSON.stringify({ sessionId: "ws-123" }),
		})
	})

	it("forwards gitToken into the create/update body when provided", async () => {
		const mockFetch = mockAuthFlow("wss://h.example.com")
		await authenticateWorkspace("ws-1", "key1", "desc", {
			endpoint: BASE,
			fetch: mockFetch,
			gitToken: "ghp_xyz",
		})

		const putBody = JSON.parse(mockFetch.mock.calls[1][1].body as string)
		expect(putBody.options.gitToken).toBe("ghp_xyz")
		expect(putBody.options.agentApiKey).toBe("key1")
	})

	it("normalizes a bare-hostname URI returned by the server", async () => {
		const bare = "trusting-titan.remote.kimchi.dev"
		const mockFetch = mockAuthFlow(bare)
		const result = await authenticateWorkspace("ws-1", "key1", "desc", { endpoint: BASE, fetch: mockFetch })
		expect(result.wsUrl).toBe(`wss://${bare}`)
		expect(result.host).toBe(bare)
	})

	it.each([
		[401, "verify"],
		[403, "verify"],
		[404, "verify"],
		[409, "verify"],
	])("surfaces %i on the verify step as RemoteAuthError (%s)", async (status) => {
		const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status }))
		await expect(
			authenticateWorkspace("ws-1", "key1", "desc", { endpoint: BASE, fetch: mockFetch }),
		).rejects.toBeInstanceOf(RemoteAuthError)
	})

	it("surfaces 401 on the create step as RemoteAuthError", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
		await expect(
			authenticateWorkspace("ws-1", "key1", "desc", { endpoint: BASE, fetch: mockFetch }),
		).rejects.toBeInstanceOf(RemoteAuthError)
	})

	it("surfaces 401 on the exchange step as RemoteAuthError", async () => {
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
		await expect(
			authenticateWorkspace("ws-1", "key1", "desc", { endpoint: BASE, fetch: mockFetch }),
		).rejects.toBeInstanceOf(RemoteAuthError)
	})

	it("surfaces 500 as RemoteNetworkError", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
		await expect(
			authenticateWorkspace("ws-1", "key1", "desc", { endpoint: BASE, fetch: mockFetch }),
		).rejects.toBeInstanceOf(RemoteNetworkError)
	})

	it("wraps fetch failures as RemoteNetworkError", async () => {
		const mockFetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"))
		await expect(
			authenticateWorkspace("ws-1", "key1", "desc", { endpoint: BASE, fetch: mockFetch }),
		).rejects.toBeInstanceOf(RemoteNetworkError)
	})

	it("rejects a non-WS protocol from the server as RemoteNetworkError", async () => {
		const mockFetch = mockAuthFlow("https://h.example.com")
		await expect(
			authenticateWorkspace("ws-1", "key1", "desc", { endpoint: BASE, fetch: mockFetch }),
		).rejects.toBeInstanceOf(RemoteNetworkError)
	})

	it("throws RemoteNetworkError when the create response is missing uri", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "ws-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
		await expect(
			authenticateWorkspace("ws-1", "key1", "desc", { endpoint: BASE, fetch: mockFetch }),
		).rejects.toBeInstanceOf(RemoteNetworkError)
	})

	it("throws RemoteNetworkError when the exchange response is missing token", async () => {
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
				new Response(JSON.stringify({ expireTime: "2026-01-01T00:00:00Z" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
		await expect(
			authenticateWorkspace("ws-1", "key1", "desc", { endpoint: BASE, fetch: mockFetch }),
		).rejects.toBeInstanceOf(RemoteNetworkError)
	})
})
