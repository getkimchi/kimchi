import { describe, expect, it, vi } from "vitest"
import { fetchOrgPolicy, parseOrgPolicy } from "./org-settings.js"

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

function routeFetch(verifyBody: unknown, resolveBody: unknown, resolveStatus = 200) {
	let call = 0
	return vi.fn(async (_url: unknown) => {
		call++
		if (call === 1) return jsonResponse(verifyBody)
		return jsonResponse(resolveBody, resolveStatus)
	}) as unknown as typeof globalThis.fetch
}

describe("parseOrgPolicy", () => {
	it("parses both fields", () => {
		expect(
			parseOrgPolicy({
				maxPermissionMode: "KIMCHI_PERMISSION_MODE_AUTO",
				usageReporting: "KIMCHI_USAGE_REPORTING_FORCE_ON",
			}),
		).toEqual({ maxPermissionMode: "AUTO", usageReporting: "FORCE_ON" })
	})

	it("returns undefined when no field is set", () => {
		expect(parseOrgPolicy({})).toBeUndefined()
		expect(parseOrgPolicy(null)).toBeUndefined()
		expect(parseOrgPolicy("nope")).toBeUndefined()
		expect(parseOrgPolicy([])).toBeUndefined()
	})

	it("drops unknown enum values", () => {
		expect(
			parseOrgPolicy({ maxPermissionMode: "KIMCHI_PERMISSION_MODE_HYPERSPEED", usageReporting: "WHATEVER" }),
		).toBeUndefined()
		expect(parseOrgPolicy({ maxPermissionMode: "AUTO" })).toBeUndefined()
	})

	it("keeps the valid field when the other is malformed", () => {
		expect(parseOrgPolicy({ maxPermissionMode: "KIMCHI_PERMISSION_MODE_PLAN", usageReporting: 7 })).toEqual({
			maxPermissionMode: "PLAN",
		})
		expect(parseOrgPolicy({ maxPermissionMode: true, usageReporting: "KIMCHI_USAGE_REPORTING_USER_CHOICE" })).toEqual({
			usageReporting: "USER_CHOICE",
		})
	})
})

describe("fetchOrgPolicy", () => {
	it("returns the resolved policy", async () => {
		const fetchImpl = routeFetch(
			{ organizationId: "org-1" },
			{ settings: {}, kimchi_policy: { maxPermissionMode: "KIMCHI_PERMISSION_MODE_PLAN" } },
		)
		await expect(fetchOrgPolicy("key", { fetch: fetchImpl })).resolves.toEqual({
			kind: "policy",
			orgId: "org-1",
			policy: { maxPermissionMode: "PLAN" },
		})
		expect(fetchImpl).toHaveBeenLastCalledWith(
			"https://api.test/ai-optimizer/v1beta/organizations/org-1/settings:resolve",
			expect.objectContaining({ method: "GET", headers: { Authorization: "Bearer key", Accept: "application/json" } }),
		)
	})

	it("returns an undefined policy when kimchi_policy is absent", async () => {
		const fetchImpl = routeFetch({ organizationId: "org-1" }, { settings: {} })
		await expect(fetchOrgPolicy("key", { fetch: fetchImpl })).resolves.toEqual({
			kind: "policy",
			orgId: "org-1",
			policy: undefined,
		})
	})

	it("reports no-access when the key fails verification", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}, 403))
		await expect(fetchOrgPolicy("key", { fetch: fetchImpl })).resolves.toEqual({ kind: "no-access" })
	})

	it("reports no-access on 401, 403 and 404 from resolve", async () => {
		for (const status of [401, 403, 404]) {
			const fetchImpl = routeFetch({ organizationId: "org-1" }, {}, status)
			await expect(fetchOrgPolicy("key", { fetch: fetchImpl })).resolves.toEqual({ kind: "no-access" })
		}
	})

	it("reports unreachable on server errors", async () => {
		const fetchImpl = routeFetch({ organizationId: "org-1" }, {}, 503)
		await expect(fetchOrgPolicy("key", { fetch: fetchImpl })).resolves.toEqual({ kind: "unreachable" })
	})

	it("reports unreachable when the fetch throws (network/timeout)", async () => {
		const fetchImpl = (async () => {
			throw new Error("network down")
		}) as unknown as typeof globalThis.fetch
		await expect(fetchOrgPolicy("key", { fetch: fetchImpl })).resolves.toEqual({ kind: "unreachable" })
	})
})
