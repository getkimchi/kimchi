import { describe, expect, it, vi } from "vitest"
import { authenticateRemoteSession, listRemoteSessions } from "./auth.js"
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
		expect(result.host).toBe("s-3380b7aa-981b-4272-8f7d-d6e41f62139f.remote.kimchi.dev")
		expect(result.port).toBe(443)

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
				new Response(JSON.stringify({ token: "tok", expireTime: "2026-01-01T00:00:00Z" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
	}

	it("accepts a bare-hostname WS uri from the server and normalizes it", async () => {
		const bare = "trusting-expensive-titan-e0baa2-a980.remote.kimchi.dev"
		const mockFetch = mockAuthFlow(bare)
		const result = await authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })

		expect(result.wsUrl).toBe(`wss://${bare}`)
		expect(result.host).toBe(bare)
		expect(result.port).toBe(443)
	})

	it("preserves an explicit non-default port", async () => {
		const mockFetch = mockAuthFlow("wss://host.example.com:9443")
		const result = await authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })

		expect(result.wsUrl).toBe("wss://host.example.com:9443")
		expect(result.host).toBe("host.example.com")
		expect(result.port).toBe(9443)
	})

	it("strips the default :443 from a fully qualified wss URI", async () => {
		const mockFetch = mockAuthFlow("wss://host.example.com:443")
		const result = await authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })

		expect(result.wsUrl).toBe("wss://host.example.com")
		expect(result.host).toBe("host.example.com")
		expect(result.port).toBe(443)
	})

	it("rejects a non-WS protocol with a RemoteNetworkError", async () => {
		const mockFetch = mockAuthFlow("https://host.example.com")
		await expect(authenticateRemoteSession("s1", "key1", { endpoint: BASE, fetch: mockFetch })).rejects.toThrow(
			/Unexpected protocol/,
		)
	})
})

const ORG_ID = "org-516442fe-054a-49e2-ac2d-9dc9b104c3d2"

function verifyResponse() {
	return new Response(JSON.stringify({ organizationId: ORG_ID }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	})
}

function listUrl(cursor?: string) {
	const params = new URLSearchParams()
	params.set("page.limit", "200")
	if (cursor) params.set("page.cursor", cursor)
	return `${BASE}/ai-optimizer/v1beta/organizations/${ORG_ID}/sessions?${params.toString()}`
}

function sessionFixture(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: "sess-1",
		organizationId: ORG_ID,
		creatorId: "user-1",
		description: "feature-x",
		status: "ACTIVE",
		createTime: "2026-05-17T10:30:00Z",
		uri: "wss://s-1.remote.kimchi.dev",
		...overrides,
	}
}

describe("listRemoteSessions", () => {
	it("returns a single page of summaries with Date instances and correct mapping", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [sessionFixture({ id: "sess-1", description: "feature-x", status: "ACTIVE" })],
						totalCount: 1,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)

		const result = await listRemoteSessions("key1", { endpoint: BASE, fetch: mockFetch })

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({
			id: "sess-1",
			name: "feature-x",
			status: "active",
			hasConnectedClient: false,
		})
		expect(result[0].createdAt).toBeInstanceOf(Date)
		expect(result[0].lastActivityAt).toBeInstanceOf(Date)
		expect(result[0].createdAt.toISOString()).toBe("2026-05-17T10:30:00.000Z")

		expect(mockFetch).toHaveBeenCalledTimes(2)
		expect(mockFetch.mock.calls[1][0]).toBe(listUrl())
		expect(mockFetch.mock.calls[1][1]).toMatchObject({
			method: "GET",
			headers: expect.objectContaining({
				Authorization: "Bearer key1",
				Accept: "application/json",
			}),
		})
	})

	it("follows cursor across multiple pages", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [sessionFixture({ id: "sess-a" })],
						nextPageCursor: "cursor-1",
						totalCount: 3,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [sessionFixture({ id: "sess-b" })],
						nextPageCursor: "cursor-2",
						totalCount: 3,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [sessionFixture({ id: "sess-c" })],
						totalCount: 3,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)

		const result = await listRemoteSessions("key1", { endpoint: BASE, fetch: mockFetch })

		expect(result.map((r) => r.id)).toEqual(["sess-a", "sess-b", "sess-c"])
		expect(mockFetch).toHaveBeenCalledTimes(4)
		expect(mockFetch.mock.calls[1][0]).toBe(listUrl())
		expect(mockFetch.mock.calls[2][0]).toBe(listUrl("cursor-1"))
		expect(mockFetch.mock.calls[3][0]).toBe(listUrl("cursor-2"))
	})

	it.each([
		["INITIALIZING", "active"],
		["ACTIVE", "active"],
		["SUSPENDED", "idle"],
		["DELETING", "completed"],
		["STATUS_UNSPECIFIED", "idle"],
		["WHO_KNOWS", "idle"],
	])("maps server status %s to %s", async (serverStatus, expected) => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [sessionFixture({ status: serverStatus })],
						totalCount: 1,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)

		const result = await listRemoteSessions("key1", { endpoint: BASE, fetch: mockFetch })
		expect(result[0].status).toBe(expected)
	})

	it("returns empty name when description is missing or empty", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [sessionFixture({ description: undefined }), sessionFixture({ id: "sess-2", description: "" })],
						totalCount: 2,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)

		const result = await listRemoteSessions("key1", { endpoint: BASE, fetch: mockFetch })
		expect(result[0].name).toBe("")
		expect(result[1].name).toBe("")
	})

	it("throws RemoteAuthError when verify returns 401", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
		await expect(listRemoteSessions("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteAuthError,
		)
	})

	it("throws RemoteAuthError when list returns 401", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
		await expect(listRemoteSessions("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteAuthError,
		)
	})

	it("throws RemoteNetworkError on 500", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(new Response(null, { status: 500 }))
		await expect(listRemoteSessions("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
	})

	it("throws RemoteNetworkError on fetch failure", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockRejectedValueOnce(new TypeError("fetch failed"))
		await expect(listRemoteSessions("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
	})

	it("throws RemoteNetworkError when response is missing items array", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ totalCount: 0 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		await expect(listRemoteSessions("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
		consoleSpy.mockRestore()
	})

	it("throws RemoteNetworkError when createTime is invalid", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [sessionFixture({ createTime: "not-a-date" })],
						totalCount: 1,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
		await expect(listRemoteSessions("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
	})

	it("propagates an external abort signal", async () => {
		const ctrl = new AbortController()
		const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
			expect(init.signal).toBeInstanceOf(AbortSignal)
			ctrl.abort()
			if (init.signal?.aborted) {
				throw new DOMException("Aborted", "AbortError")
			}
			return verifyResponse()
		})

		await expect(
			listRemoteSessions("key1", { endpoint: BASE, fetch: mockFetch, signal: ctrl.signal }),
		).rejects.toBeInstanceOf(RemoteNetworkError)
	})

	it("stops after the hard page cap even if cursor keeps coming back", async () => {
		const mockFetch = vi.fn().mockImplementation((url: string) => {
			if (typeof url === "string" && url.endsWith("/api-keys:verify")) {
				return Promise.resolve(verifyResponse())
			}
			return Promise.resolve(
				new Response(
					JSON.stringify({
						items: [sessionFixture({ id: `sess-${Math.random()}` })],
						nextPageCursor: "never-ends",
						totalCount: 999,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
		})

		const result = await listRemoteSessions("key1", { endpoint: BASE, fetch: mockFetch })

		// 10 pages, 1 item per page
		expect(result).toHaveLength(10)
		// 1 verify + 10 list pages = 11 total fetches
		expect(mockFetch).toHaveBeenCalledTimes(11)
	})
})
