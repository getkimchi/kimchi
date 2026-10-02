import { describe, expect, it, vi } from "vitest"
import { getOrganization, verifyApiKey } from "./organizations.js"

vi.mock("../config.js", () => ({
	resolveEndpoints: () => ({ platformApiUrl: "https://api.test" }),
}))
vi.mock("../utils/http.js", () => ({
	fetchWithRetry: (_url: string, init: RequestInit, options: { fetchImpl?: typeof globalThis.fetch }) =>
		(options.fetchImpl ?? globalThis.fetch)(_url, init),
}))

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("verifyApiKey", () => {
	it("returns the org id the key is scoped to", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ organizationId: "org-1", userId: "user-1" }))
		await expect(verifyApiKey("key", { fetch: fetchImpl })).resolves.toEqual({ organizationId: "org-1" })
		expect(fetchImpl).toHaveBeenCalledWith("https://api.test/ai-optimizer/v1beta/api-keys:verify", {
			method: "POST",
			headers: { Authorization: "Bearer key", Accept: "application/json" },
		})
	})

	it("throws when the org id is missing", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ userId: "user-1" }))
		await expect(verifyApiKey("key", { fetch: fetchImpl })).rejects.toThrow("Missing organizationId")
	})

	it("throws on non-OK responses", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}, 403))
		await expect(verifyApiKey("key", { fetch: fetchImpl })).rejects.toThrow("HTTP 403")
	})
})

describe("getOrganization", () => {
	it("fetches a single organization by id", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ id: "org-1", name: "CAST AI" }))
		await expect(getOrganization("key", "org-1", { fetch: fetchImpl })).resolves.toEqual({
			id: "org-1",
			name: "CAST AI",
		})
		expect(fetchImpl).toHaveBeenCalledWith("https://api.test/v1/organizations/org-1", {
			method: "GET",
			headers: { Authorization: "Bearer key", Accept: "application/json" },
		})
	})

	it("throws when the name is missing", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ id: "org-1" }))
		await expect(getOrganization("key", "org-1", { fetch: fetchImpl })).rejects.toThrow("Missing name")
	})

	it("throws on non-OK responses", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}, 404))
		await expect(getOrganization("key", "org-1", { fetch: fetchImpl })).rejects.toThrow("HTTP 404")
	})
})
