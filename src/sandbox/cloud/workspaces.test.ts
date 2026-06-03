import { describe, expect, it, vi } from "vitest"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"
import { deleteWorkspace, listWorkspaces } from "./workspaces.js"

const BASE = "https://api.example.com"
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

function workspaceFixture(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: "ws-1",
		organizationId: ORG_ID,
		creatorId: "user-1",
		description: "feature-x",
		status: "ACTIVE",
		createTime: "2026-05-17T10:30:00Z",
		uri: "wss://ws-1.remote.kimchi.dev",
		...overrides,
	}
}

describe("listWorkspaces", () => {
	it("returns a single page of Workspace objects with Date instances and parsed host", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [workspaceFixture({ id: "ws-1", description: "feature-x", status: "ACTIVE" })],
						totalCount: 1,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)

		const result = await listWorkspaces("key1", { endpoint: BASE, fetch: mockFetch })

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({
			id: "ws-1",
			name: "feature-x",
			status: "active",
			host: "ws-1.remote.kimchi.dev",
		})
		// New Workspace shape must NOT carry hasConnectedClient.
		expect((result[0] as unknown as { hasConnectedClient?: boolean }).hasConnectedClient).toBeUndefined()
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
						items: [workspaceFixture({ id: "ws-a" })],
						nextPageCursor: "cursor-1",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [workspaceFixture({ id: "ws-b" })],
						nextPageCursor: "cursor-2",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ items: [workspaceFixture({ id: "ws-c" })] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)

		const result = await listWorkspaces("key1", { endpoint: BASE, fetch: mockFetch })

		expect(result.map((r) => r.id)).toEqual(["ws-a", "ws-b", "ws-c"])
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
				new Response(JSON.stringify({ items: [workspaceFixture({ status: serverStatus })] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)

		const result = await listWorkspaces("key1", { endpoint: BASE, fetch: mockFetch })
		expect(result[0].status).toBe(expected)
	})

	it("stops after the hard page cap even if cursor keeps coming back", async () => {
		const mockFetch = vi.fn().mockImplementation((url: string) => {
			if (typeof url === "string" && url.endsWith("/api-keys:verify")) {
				return Promise.resolve(verifyResponse())
			}
			return Promise.resolve(
				new Response(
					JSON.stringify({
						items: [workspaceFixture({ id: `ws-${Math.random()}` })],
						nextPageCursor: "never-ends",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
		})

		const result = await listWorkspaces("key1", { endpoint: BASE, fetch: mockFetch })

		// 10 pages, 1 item per page
		expect(result).toHaveLength(10)
		// 1 verify + 10 list pages = 11 total fetches
		expect(mockFetch).toHaveBeenCalledTimes(11)
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
			listWorkspaces("key1", { endpoint: BASE, fetch: mockFetch, signal: ctrl.signal }),
		).rejects.toBeInstanceOf(RemoteNetworkError)
	})

	it("throws RemoteAuthError on 401 from list", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
		await expect(listWorkspaces("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(RemoteAuthError)
	})

	it("throws RemoteNetworkError on 500", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(new Response(null, { status: 500 }))
		await expect(listWorkspaces("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
	})

	it("throws RemoteNetworkError when items array is missing", async () => {
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
		await expect(listWorkspaces("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
		consoleSpy.mockRestore()
	})

	it("throws RemoteNetworkError when createTime is invalid", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(verifyResponse())
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ items: [workspaceFixture({ createTime: "not-a-date" })] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
		await expect(listWorkspaces("key1", { endpoint: BASE, fetch: mockFetch })).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
	})
})

describe("deleteWorkspace", () => {
	it("sends a DELETE with the bearer token to the correct URL", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))

		await deleteWorkspace("org-1", "ws-1", "key1", { endpoint: BASE, fetch: mockFetch })

		expect(mockFetch).toHaveBeenCalledTimes(1)
		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/ai-optimizer/v1beta/organizations/org-1/sessions/ws-1`)
		expect(mockFetch.mock.calls[0][1]).toMatchObject({
			method: "DELETE",
			headers: expect.objectContaining({ Authorization: "Bearer key1" }),
		})
	})

	it("surfaces 404 as RemoteAuthError", async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }))
		await expect(
			deleteWorkspace("org-1", "missing", "key1", { endpoint: BASE, fetch: mockFetch }),
		).rejects.toBeInstanceOf(RemoteAuthError)
	})
})
