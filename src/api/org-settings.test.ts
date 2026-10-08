import { describe, expect, it, vi } from "vitest"
import { fetchOrgPolicy, parseOrgPolicy } from "./org-settings.js"

vi.mock("../config.js", () => ({
	resolveEndpoints: () => ({ platformApiUrl: "https://api.test" }),
}))

// Capture the options fetchWithRetry was called with so the tests can assert
// the startup budget contract (short timeout, no retries).
const fetchWithRetryOptions: unknown[] = []
vi.mock("../utils/http.js", () => ({
	fetchWithRetry: vi.fn((_url: string, init: RequestInit, options: { fetchImpl?: typeof globalThis.fetch }) => {
		fetchWithRetryOptions.push(options)
		return (options.fetchImpl ?? globalThis.fetch)(_url, init)
	}),
}))

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function routeFetch(verifyBody: unknown, resolveBody: unknown, resolveStatus = 200) {
	let call = 0
	return vi.fn(async () => {
		call++
		if (call === 1) return jsonResponse(verifyBody)
		return jsonResponse(resolveBody, resolveStatus)
	}) as unknown as typeof globalThis.fetch
}

describe("parseOrgPolicy", () => {
	it("parses both fields from the gateway's camelCase JSON", () => {
		expect(
			parseOrgPolicy({
				kimchiMaxPermissionMode: "KIMCHI_PERMISSION_MODE_AUTO",
				kimchiUsageReporting: "KIMCHI_USAGE_REPORTING_FORCE_ON",
			}),
		).toEqual({ maxPermissionMode: "AUTO", usageReporting: "FORCE_ON" })
	})

	it("accepts snake_case field names (UseProtoNames gateways)", () => {
		expect(
			parseOrgPolicy({
				kimchi_max_permission_mode: "KIMCHI_PERMISSION_MODE_PLAN",
				kimchi_usage_reporting: "KIMCHI_USAGE_REPORTING_USER_CHOICE",
			}),
		).toEqual({ maxPermissionMode: "PLAN", usageReporting: "USER_CHOICE" })
	})

	it("returns undefined when the settings object is absent", () => {
		expect(parseOrgPolicy(undefined)).toBeUndefined()
	})

	it("returns undefined when no field is set", () => {
		expect(parseOrgPolicy({})).toBeUndefined()
		expect(parseOrgPolicy(null)).toBeUndefined()
		expect(parseOrgPolicy("nope")).toBeUndefined()
		expect(parseOrgPolicy([])).toBeUndefined()
	})

	it("drops unknown enum values", () => {
		expect(
			parseOrgPolicy({
				kimchiMaxPermissionMode: "KIMCHI_PERMISSION_MODE_HYPERSPEED",
				kimchiUsageReporting: "WHATEVER",
			}),
		).toBeUndefined()
		expect(parseOrgPolicy({ kimchiMaxPermissionMode: "AUTO" })).toBeUndefined()
	})

	it("keeps the valid field when the other is malformed", () => {
		expect(parseOrgPolicy({ kimchiMaxPermissionMode: "KIMCHI_PERMISSION_MODE_PLAN", kimchiUsageReporting: 7 })).toEqual(
			{
				maxPermissionMode: "PLAN",
			},
		)
		expect(
			parseOrgPolicy({ kimchiMaxPermissionMode: true, kimchiUsageReporting: "KIMCHI_USAGE_REPORTING_USER_CHOICE" }),
		).toEqual({
			usageReporting: "USER_CHOICE",
		})
	})
})

describe("fetchOrgPolicy", () => {
	it("returns the resolved policy from the gateway's camelCase JSON", async () => {
		const fetchImpl = routeFetch(
			{ organizationId: "org-1" },
			{ settings: { kimchiMaxPermissionMode: "KIMCHI_PERMISSION_MODE_PLAN" } },
		)
		await expect(fetchOrgPolicy("key", { fetch: fetchImpl })).resolves.toEqual({
			kind: "policy",
			orgId: "org-1",
			policy: { maxPermissionMode: "PLAN" },
		})
	})

	it("accepts snake_case resolve responses", async () => {
		const fetchImpl = routeFetch(
			{ organizationId: "org-1" },
			{ settings: { kimchi_max_permission_mode: "KIMCHI_PERMISSION_MODE_YOLO" } },
		)
		await expect(fetchOrgPolicy("key", { fetch: fetchImpl })).resolves.toEqual({
			kind: "policy",
			orgId: "org-1",
			policy: { maxPermissionMode: "YOLO" },
		})
	})

	it("returns an undefined policy when the policy object is absent", async () => {
		const fetchImpl = routeFetch({ organizationId: "org-1" }, { settings: {} })
		await expect(fetchOrgPolicy("key", { fetch: fetchImpl })).resolves.toEqual({
			kind: "policy",
			orgId: "org-1",
			policy: undefined,
		})
	})

	it("applies the startup budget to both the verify and the resolve call", async () => {
		fetchWithRetryOptions.length = 0
		const fetchImpl = routeFetch({ organizationId: "org-1" }, { settings: {} })
		await fetchOrgPolicy("key", { fetch: fetchImpl })

		expect(fetchWithRetryOptions).toHaveLength(2)
		for (const options of fetchWithRetryOptions) {
			expect(options).toMatchObject({ timeoutMs: 1500, retry: { maxRetries: 0 } })
		}
	})

	it("reports no-access when the key fails verification", async () => {
		const fetchImpl = (async () => jsonResponse({}, 403)) as unknown as typeof globalThis.fetch
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

	it("reports unreachable when a fetch throws (network/timeout)", async () => {
		const fetchImpl = (async () => {
			throw new Error("network down")
		}) as unknown as typeof globalThis.fetch
		await expect(fetchOrgPolicy("key", { fetch: fetchImpl })).resolves.toEqual({ kind: "unreachable" })
	})

	it("reports unreachable on a 200 with a non-JSON body (gateway glitch)", async () => {
		let call = 0
		const fetchImpl = (async () => {
			call++
			if (call === 1) return jsonResponse({ organizationId: "org-1" })
			return new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } })
		}) as unknown as typeof globalThis.fetch
		await expect(fetchOrgPolicy("key", { fetch: fetchImpl })).resolves.toEqual({ kind: "unreachable" })
	})

	it("reports unreachable on a 200 with a non-JSON verify body", async () => {
		let call = 0
		const fetchImpl = (async () => {
			call++
			if (call === 1) return new Response("nope", { status: 200, headers: { "content-type": "text/plain" } })
			return jsonResponse({})
		}) as unknown as typeof globalThis.fetch
		await expect(fetchOrgPolicy("key", { fetch: fetchImpl })).resolves.toEqual({ kind: "unreachable" })
	})
})
