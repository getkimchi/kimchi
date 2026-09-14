import { describe, expect, it, vi } from "vitest"
import { authenticateWorkspace, authenticateWorkspaceProbe } from "./auth.js"
import { RemoteAuthError, RemoteNetworkError, RemoteQuotaError } from "./types.js"

const BASE = "https://api.example.com"

function mockAuthFlow(uri: string) {
	return (
		vi
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
			// Hibernation wake: POST .../workspaces/{id}:resume (before the token exchange)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({}), {
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
				new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
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

		expect(mockFetch).toHaveBeenCalledTimes(4)
		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/ai-optimizer/v1beta/workspace-tokens:verifyKey`)
		expect(mockFetch.mock.calls[1][0]).toBe(
			`${BASE}/ai-optimizer/v1beta/organizations/org-516442fe-054a-49e2-ac2d-9dc9b104c3d2/workspaces/ws-123`,
		)
		expect(mockFetch.mock.calls[1][1]).toMatchObject({ method: "PUT" })
		// Hibernation wake runs right after the upsert — the upsert only
		// refreshes metadata and never scales the sandbox pod; resume does.
		expect(mockFetch.mock.calls[2][0]).toBe(
			`${BASE}/ai-optimizer/v1beta/organizations/org-516442fe-054a-49e2-ac2d-9dc9b104c3d2/workspaces/ws-123:resume`,
		)
		expect(mockFetch.mock.calls[2][1]).toMatchObject({
			method: "POST",
			body: JSON.stringify({}),
		})
		expect(mockFetch.mock.calls[3][0]).toBe(`${BASE}/ai-optimizer/v1beta/workspace-tokens:exchange`)
		expect(mockFetch.mock.calls[3][1]).toMatchObject({
			method: "POST",
			body: JSON.stringify({ workspaceId: "ws-123" }),
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

	it("includes resources at the top level of the create/update body when provided", async () => {
		const mockFetch = mockAuthFlow("wss://h.example.com")
		await authenticateWorkspace("ws-1", "key1", "desc", {
			endpoint: BASE,
			fetch: mockFetch,
			resources: { cpu: "250m", memory: "1Gi", pvcSize: "20Gi" },
		})

		const putBody = JSON.parse(mockFetch.mock.calls[1][1].body as string)
		expect(putBody.resources).toEqual({ cpu: "250m", memory: "1Gi", pvcSize: "20Gi" })
	})

	it("sends only the resource fields that are set", async () => {
		const mockFetch = mockAuthFlow("wss://h.example.com")
		await authenticateWorkspace("ws-1", "key1", "desc", {
			endpoint: BASE,
			fetch: mockFetch,
			resources: { memory: "1Gi" },
		})

		const putBody = JSON.parse(mockFetch.mock.calls[1][1].body as string)
		expect(putBody.resources).toEqual({ memory: "1Gi" })
	})

	it("omits the resources key entirely when not provided (re-auth stays byte-identical)", async () => {
		const mockFetch = mockAuthFlow("wss://h.example.com")
		await authenticateWorkspace("ws-1", "key1", "desc", { endpoint: BASE, fetch: mockFetch })

		const putBody = JSON.parse(mockFetch.mock.calls[1][1].body as string)
		expect(Object.keys(putBody).sort()).toEqual(["description", "options"])
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

	it("treats resume's 'not suspended' rejection as success — the workspace is already running", async () => {
		// The server rejects resume with FailedPrecondition (400) when the
		// workspace is running — the common case. It is ground truth from the
		// control plane (not a stale DB status), so auth succeeds.
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ uri: "wss://h.example.com" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ message: "resume workspace: workspace is not suspended" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ token: "jwt-tok", expireTime: "2026-01-01T00:00:00Z" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)

		const result = await authenticateWorkspace("ws-1", "key1", "desc", { endpoint: BASE, fetch: mockFetch })
		expect(result.connectToken).toBe("jwt-tok")
		expect(mockFetch).toHaveBeenCalledTimes(4)
		expect(mockFetch.mock.calls[2][0]).toContain(":resume")
	})

	it.each([
		[400, "resume workspace: sandbox creation disabled"],
		[429, "quota exceeded: user CPU limit exceeded"],
		[500, "resume workspace: boom"],
	])("propagates resume failures (%i) instead of risking a hibernated workspace", async (status, message) => {
		// Resume is the ONLY way out of hibernation — swallowing a resume
		// error would surface later as a readiness-probe hang. Fail honestly.
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ uri: "wss://h.example.com" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ message }), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
			)

		await expect(
			authenticateWorkspace("ws-1", "key1", "desc", { endpoint: BASE, fetch: mockFetch }),
		).rejects.toBeInstanceOf(RemoteNetworkError)
		// The token exchange (4th call) must not run after a failed resume.
		expect(mockFetch).toHaveBeenCalledTimes(3)
	})

	it("preserves the RemoteQuotaError classification when resume quota-checks reject (regression)", async () => {
		// resumeWorkspace consumes the body for its 'not suspended' check —
		// checkResponse must still see it (clone), or the 429 quota message is
		// lost and the typed quota error degrades to a generic network error.
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ uri: "wss://h.example.com" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ message: "quota exceeded: user CPU limit exceeded" }), {
					status: 429,
					headers: { "Content-Type": "application/json" },
				}),
			)

		const err = await authenticateWorkspace("ws-1", "key1", "desc", { endpoint: BASE, fetch: mockFetch }).then(
			(result) => {
				expect.unreachable(`expected quota failure, got credentials ${JSON.stringify(result)}`)
			},
			(e: unknown) => e,
		)
		expect(err).toBeInstanceOf(RemoteQuotaError)
		expect((err as Error).message).toContain("user CPU limit exceeded")
	})

	it("propagates resume transport failures as RemoteNetworkError", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ uri: "wss://h.example.com" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockRejectedValueOnce(new TypeError("fetch failed"))

		await expect(
			authenticateWorkspace("ws-1", "key1", "desc", { endpoint: BASE, fetch: mockFetch }),
		).rejects.toBeInstanceOf(RemoteNetworkError)
	})
})

describe("authenticateWorkspaceProbe", () => {
	it("runs exactly 3 fetches: verifyKey (POST), GET workspace, token exchange (POST) — no PUT, no resume", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ uri: "wss://h.example.com" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ token: "jwt-probe", expireTime: "2026-01-01T00:00:00Z" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)

		const result = await authenticateWorkspaceProbe("ws-1", "key1", { endpoint: BASE, fetch: mockFetch })

		expect(mockFetch).toHaveBeenCalledTimes(3)
		expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/ai-optimizer/v1beta/workspace-tokens:verifyKey`)
		expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: "POST" })
		expect(mockFetch.mock.calls[1][0]).toBe(`${BASE}/ai-optimizer/v1beta/organizations/org-1/workspaces/ws-1`)
		expect(mockFetch.mock.calls[1][1]).toMatchObject({ method: "GET" })
		expect(mockFetch.mock.calls[2][0]).toBe(`${BASE}/ai-optimizer/v1beta/workspace-tokens:exchange`)
		expect(mockFetch.mock.calls[2][1]).toMatchObject({
			method: "POST",
			body: JSON.stringify({ workspaceId: "ws-1" }),
		})
		// No side effects: no upsert PUT and no :resume anywhere.
		for (const call of mockFetch.mock.calls) {
			expect(call[0]).not.toContain(":resume")
			expect((call[1] as RequestInit).method).not.toBe("PUT")
		}

		expect(result.connectToken).toBe("jwt-probe")
		expect(result.expiresAt).toBe("2026-01-01T00:00:00Z")
		expect(result.wsUrl).toBe("wss://h.example.com")
		expect(result.host).toBe("h.example.com")
	})

	it("mirrors a bare-hostname uri from the GET response", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ uri: "trusting-titan.remote.kimchi.dev" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ token: "t", expireTime: "e" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)

		const result = await authenticateWorkspaceProbe("ws-1", "key1", { endpoint: BASE, fetch: mockFetch })
		expect(result.wsUrl).toBe("wss://trusting-titan.remote.kimchi.dev")
		expect(result.host).toBe("trusting-titan.remote.kimchi.dev")
	})

	it("surfaces a 404 on the GET as RemoteAuthError — and never exchanges a token", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ organizationId: "org-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 404 }))

		await expect(
			authenticateWorkspaceProbe("ws-1", "key1", { endpoint: BASE, fetch: mockFetch }),
		).rejects.toBeInstanceOf(RemoteAuthError)
		expect(mockFetch).toHaveBeenCalledTimes(2)
	})
})
