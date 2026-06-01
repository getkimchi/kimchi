import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getMe } from "./me.js"

describe("getMe", () => {
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		originalFetch = globalThis.fetch
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	it("returns the user profile on success", async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ id: "user-1", email: "alice@example.com", name: "Alice" }),
		})
		const me = await getMe("test-key", { fetch: mockFetch })
		expect(me).toEqual({ id: "user-1", email: "alice@example.com", name: "Alice" })
		expect(mockFetch).toHaveBeenCalledOnce()
		const [url, opts] = mockFetch.mock.calls[0]
		expect(url).toBe("https://app.kimchi.dev/api/v1/me")
		expect(opts.headers.Authorization).toBe("Bearer test-key")
	})

	it("uses custom endpoint when provided", async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ id: "user-2" }),
		})
		await getMe("key", { endpoint: "https://custom.example.com/api", fetch: mockFetch })
		const [url] = mockFetch.mock.calls[0]
		expect(url).toBe("https://custom.example.com/api/v1/me")
	})

	it("throws on non-ok response", async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
		})
		await expect(getMe("bad-key", { fetch: mockFetch })).rejects.toThrow("HTTP 401")
	})

	it("throws on missing id in response", async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ email: "no-id@example.com" }),
		})
		await expect(getMe("key", { fetch: mockFetch })).rejects.toThrow("Missing id")
	})

	it("throws on non-JSON response", async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => {
				throw new SyntaxError("Unexpected token")
			},
		})
		await expect(getMe("key", { fetch: mockFetch })).rejects.toThrow("non-JSON")
	})

	it("passes signal through to fetch", async () => {
		const controller = new AbortController()
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ id: "user-1" }),
		})
		await getMe("key", { fetch: mockFetch, signal: controller.signal })
		const [, opts] = mockFetch.mock.calls[0]
		expect(opts.signal).toBe(controller.signal)
	})
})
