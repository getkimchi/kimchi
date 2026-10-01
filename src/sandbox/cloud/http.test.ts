import { afterEach, describe, expect, it, vi } from "vitest"
import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"

describe("resolveEndpoint", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("prefers the explicit option over env and default", () => {
		vi.stubEnv("KIMCHI_REMOTE_ENDPOINT", "https://from-env.example.com")
		expect(resolveEndpoint({ endpoint: "https://from-opt.example.com" })).toBe("https://from-opt.example.com")
	})

	it("falls back to KIMCHI_REMOTE_ENDPOINT when no option", () => {
		vi.stubEnv("KIMCHI_REMOTE_ENDPOINT", "https://from-env.example.com")
		expect(resolveEndpoint()).toBe("https://from-env.example.com")
	})

	it("falls back to the production default when no option and no env", () => {
		vi.stubEnv("KIMCHI_REMOTE_ENDPOINT", undefined)
		expect(resolveEndpoint()).toBe("https://app.kimchi.dev/api")
	})
})

describe("checkResponse", () => {
	it("returns void on 2xx", async () => {
		await expect(checkResponse(new Response(null, { status: 200 }), "https://x")).resolves.toBeUndefined()
	})

	it.each([
		[401, RemoteAuthError],
		[403, RemoteAuthError],
		[404, RemoteAuthError],
		[409, RemoteAuthError],
	])("maps %i to RemoteAuthError with matching statusCode", async (status, ErrorCtor) => {
		try {
			await checkResponse(new Response(null, { status }), "https://x")
			throw new Error("did not throw")
		} catch (err) {
			expect(err).toBeInstanceOf(ErrorCtor)
			expect((err as RemoteAuthError).statusCode).toBe(status)
		}
	})

	it("maps 500 to RemoteNetworkError including the body when present", async () => {
		const resp = new Response("server boom", { status: 500 })
		await expect(checkResponse(resp, "https://x")).rejects.toMatchObject({
			name: "RemoteNetworkError",
			message: expect.stringContaining("server boom"),
		})
	})

	it("maps 429 quota bodies to a friendly RemoteQuotaError", async () => {
		const resp = new Response('{"message":"quota exceeded: user CPU limit exceeded","fieldViolations":[]}', {
			status: 429,
		})
		await expect(checkResponse(resp, "https://x")).rejects.toMatchObject({
			name: "RemoteQuotaError",
			message: "Unable to provision workspace: user CPU limit exceeded",
			statusCode: 429,
		})
	})

	it("keeps a 429 message verbatim when it has no 'quota exceeded' prefix", async () => {
		const resp = new Response('{"message":"user memory limit exceeded"}', { status: 429 })
		await expect(checkResponse(resp, "https://x")).rejects.toMatchObject({
			name: "RemoteQuotaError",
			message: "Unable to provision workspace: user memory limit exceeded",
		})
	})

	it("falls back to the raw format for 429s without a JSON message", async () => {
		const resp = new Response("slow down", { status: 429 })
		await expect(checkResponse(resp, "https://x")).rejects.toMatchObject({
			name: "RemoteNetworkError",
			message: expect.stringContaining("HTTP 429 from https://x"),
		})
	})

	it("maps the humanized aggregation message (usage/requested/limit values)", async () => {
		const resp = new Response(
			'{"message":"quota exceeded: user cpu limit exceeded (current usage 9500m, requested 1, limit 10)","fieldViolations":[]}',
			{ status: 429 },
		)
		await expect(checkResponse(resp, "https://x")).rejects.toMatchObject({
			name: "RemoteQuotaError",
			message: "Unable to provision workspace: user cpu limit exceeded (current usage 9500m, requested 1, limit 10)",
			statusCode: 429,
		})
	})

	it("maps the humanized multi-dimension resolution message verbatim", async () => {
		const resp = new Response(
			'{"message":"failed to resolve workspace resources: workspace resource request exceeds the per-user quota limit: memory requested 150Gi exceeds the per-user limit 120Gi; pvcSize requested 500Gi exceeds the per-user limit 120Gi","fieldViolations":[]}',
			{ status: 429 },
		)
		await expect(checkResponse(resp, "https://x")).rejects.toMatchObject({
			name: "RemoteQuotaError",
			message:
				"Unable to provision workspace: failed to resolve workspace resources: workspace resource request exceeds the per-user quota limit: memory requested 150Gi exceeds the per-user limit 120Gi; pvcSize requested 500Gi exceeds the per-user limit 120Gi",
		})
	})

	it("maps non-auth statuses without a body to RemoteNetworkError", async () => {
		await expect(checkResponse(new Response(null, { status: 502 }), "https://x")).rejects.toBeInstanceOf(
			RemoteNetworkError,
		)
	})
})

describe("fetchWithTimeout", () => {
	it("aborts the inner fetch when ms elapses", async () => {
		const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
			return new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
			})
		})
		await expect(fetchWithTimeout("https://x", {}, fetchImpl, 5)).rejects.toMatchObject({ name: "AbortError" })
	})

	it("composes the external signal with the timeout signal", async () => {
		const ctrl = new AbortController()
		const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
			return new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
			})
		})
		const p = fetchWithTimeout("https://x", {}, fetchImpl, 60_000, ctrl.signal)
		setTimeout(() => ctrl.abort(), 5)
		await expect(p).rejects.toMatchObject({ name: "AbortError" })
	})

	it("returns the response when fetch resolves before timeout", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
		const resp = await fetchWithTimeout("https://x", {}, fetchImpl, 1_000)
		expect(resp.status).toBe(200)
	})
})
