import { describe, expect, it, vi } from "vitest"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"
import { listWorkspaceTemplates } from "./workspace-templates.js"

const BASE = "https://api.example.com"

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

describe("listWorkspaceTemplates", () => {
	it("lists templates with bearer auth and maps id/name/description", async () => {
		const mockFetch = vi.fn().mockResolvedValue(
			jsonResponse({
				items: [
					{
						id: "tpl-1",
						name: "team-stack",
						description: "Team defaults",
						spec: {
							resources: { cpu: "1", memory: "2Gi", pvcSize: "10Gi" },
							dependencies: ["jq", "node@22"],
							egressPolicy: { denyByDefault: true, allowed: ["github.com:443"] },
						},
					},
					{ id: "tpl-2", name: "minimal", description: "" },
				],
				totalCount: 2,
			}),
		)

		const result = await listWorkspaceTemplates("key1", { endpoint: BASE, fetch: mockFetch, orgId: "org-1" })

		expect(mockFetch).toHaveBeenCalledOnce()
		const [url, init] = mockFetch.mock.calls[0]
		expect(url).toBe(`${BASE}/ai-optimizer/v1beta/organizations/org-1/workspace-templates?page.limit=200`)
		expect((init as RequestInit).method).toBe("GET")
		expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer key1" })
		// The preset parameters map for read-only display; initScript/files are
		// not surfaced.
		expect(result).toEqual([
			{
				id: "tpl-1",
				name: "team-stack",
				description: "Team defaults",
				spec: {
					resources: { cpu: "1", memory: "2Gi", pvcSize: "10Gi" },
					dependencies: ["jq", "node@22"],
					egressPolicy: { denyByDefault: true, allowed: ["github.com:443"] },
				},
			},
			{ id: "tpl-2", name: "minimal", description: "", spec: undefined },
		])
	})

	it("drops malformed spec sections but keeps the rest of the template", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		const mockFetch = vi.fn().mockResolvedValue(
			jsonResponse({
				items: [
					{
						id: "tpl-1",
						name: "broken-spec",
						spec: { resources: { cpu: 2 }, dependencies: "jq", egressPolicy: { denyByDefault: "yes" } },
					},
				],
			}),
		)

		const result = await listWorkspaceTemplates("key1", { endpoint: BASE, fetch: mockFetch, orgId: "org-1" })

		expect(result).toEqual([{ id: "tpl-1", name: "broken-spec", description: "", spec: undefined }])
		consoleError.mockRestore()
	})

	it("paginates via nextPageCursor until exhausted", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ items: [{ id: "a", name: "first" }], nextPageCursor: "c2" }))
			.mockResolvedValueOnce(jsonResponse({ items: [{ id: "b", name: "second" }] }))

		const result = await listWorkspaceTemplates("key1", { endpoint: BASE, fetch: mockFetch, orgId: "org-1" })

		expect(result.map((t) => t.name)).toEqual(["first", "second"])
		expect(mockFetch).toHaveBeenCalledTimes(2)
		expect(mockFetch.mock.calls[1][0]).toContain("page.cursor=c2")
	})

	it("resolves the orgId via verifyApiKey when not passed through", async () => {
		const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ items: [] }))
		const verify = vi.fn().mockResolvedValue({ organizationId: "org-9", userId: "user-1" })
		// verifyApiKey is imported inside the module; stub via module mock is
		// overkill for one assertion — inject through the key-verification path
		// by asserting the request went to the resolved org's URL.
		const mod = await import("./keys.js")
		vi.spyOn(mod, "verifyApiKey").mockImplementation(verify as never)

		await listWorkspaceTemplates("key1", { endpoint: BASE, fetch: mockFetch })

		expect(mockFetch.mock.calls[0][0]).toContain("/organizations/org-9/")
		vi.restoreAllMocks()
	})

	it("skips malformed entries but keeps valid ones", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		const mockFetch = vi.fn().mockResolvedValue(
			jsonResponse({
				items: [{ id: "ok", name: "good" }, { name: "no-id" }, "garbage", { id: "", name: "empty-id" }],
			}),
		)

		const result = await listWorkspaceTemplates("key1", { endpoint: BASE, fetch: mockFetch, orgId: "org-1" })

		expect(result).toEqual([{ id: "ok", name: "good", description: "" }])
		expect(consoleError).toHaveBeenCalledTimes(3)
		consoleError.mockRestore()
	})

	it("throws RemoteNetworkError on a missing items array", async () => {
		const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ unexpected: true }))
		await expect(
			listWorkspaceTemplates("key1", { endpoint: BASE, fetch: mockFetch, orgId: "org-1" }),
		).rejects.toBeInstanceOf(RemoteNetworkError)
	})

	it("preserves RemoteAuthError and wraps other failures", async () => {
		const authFail = vi.fn().mockResolvedValue(jsonResponse({ message: "nope" }, 401))
		await expect(
			listWorkspaceTemplates("key1", { endpoint: BASE, fetch: authFail, orgId: "org-1" }),
		).rejects.toBeInstanceOf(RemoteAuthError)

		const networkFail = vi.fn().mockRejectedValue(new TypeError("fetch failed"))
		await expect(
			listWorkspaceTemplates("key1", { endpoint: BASE, fetch: networkFail, orgId: "org-1" }),
		).rejects.toBeInstanceOf(RemoteNetworkError)
	})
})
