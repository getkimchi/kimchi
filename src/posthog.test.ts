import { randomUUID } from "node:crypto"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { capturePostHogEvent } from "./posthog.js"

describe("capturePostHogEvent", () => {
	const testApiKey = "test-project-token-123"
	const testDeviceId = randomUUID()

	beforeEach(() => {
		vi.stubEnv("KIMCHI_POSTHOG_API_KEY", testApiKey)
	})

	afterAll(() => {
		vi.unstubAllEnvs()
	})

	it("sends a POST to the PostHog capture endpoint", async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		// @ts-ignore — replace global fetch for the test
		const originalFetch = globalThis.fetch
		// @ts-ignore
		globalThis.fetch = mockFetch

		await capturePostHogEvent({
			event: "app_started",
			distinctId: testDeviceId,
			properties: { cli_version: "0.0.64", os: "darwin", arch: "arm64" },
		})

		expect(mockFetch).toHaveBeenCalledOnce()
		expect(mockFetch.mock.calls[0]).toBeDefined()
		const [url, options] = mockFetch.mock.calls[0]
		expect(url).toBe("https://eu.i.posthog.com/i/v0/e")

		const body = JSON.parse(options.body as string)
		expect(body.api_key).toBe(testApiKey)
		expect(body.event).toBe("app_started")
		expect(body.distinct_id).toBe(testDeviceId)
		expect(body.properties).toEqual({ cli_version: "0.0.64", os: "darwin", arch: "arm64" })
		expect(body.timestamp).toBeTruthy()

		// @ts-ignore
		globalThis.fetch = originalFetch
	})

	it("sends correct Content-Type header", async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		// @ts-ignore
		const originalFetch = globalThis.fetch
		// @ts-ignore
		globalThis.fetch = mockFetch

		await capturePostHogEvent({ event: "harness_launched", distinctId: testDeviceId })

		expect(mockFetch).toHaveBeenCalledOnce()
		expect(mockFetch.mock.calls[0]).toBeDefined()
		const [, options] = mockFetch.mock.calls[0]
		expect(options.headers["Content-Type"]).toBe("application/json")

		// @ts-ignore
		globalThis.fetch = originalFetch
	})

	it("is a no-op when KIMCHI_POSTHOG_API_KEY is empty", async () => {
		vi.stubEnv("KIMCHI_POSTHOG_API_KEY", "")
		const mockFetch = vi.fn()
		// @ts-ignore
		const originalFetch = globalThis.fetch
		// @ts-ignore
		globalThis.fetch = mockFetch

		await capturePostHogEvent({ event: "app_started", distinctId: testDeviceId })

		expect(mockFetch).not.toHaveBeenCalled()

		// @ts-ignore
		globalThis.fetch = originalFetch
	})

	it("swallows errors and does not throw", async () => {
		const mockFetch = vi.fn().mockRejectedValue(new Error("network error"))
		// @ts-ignore
		const originalFetch = globalThis.fetch
		// @ts-ignore
		globalThis.fetch = mockFetch

		await expect(capturePostHogEvent({ event: "app_started", distinctId: testDeviceId })).resolves.toBeUndefined()

		// @ts-ignore
		globalThis.fetch = originalFetch
	})

	it("resolves successfully even when fetch returns a non-ok response", async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 })
		// @ts-ignore
		const originalFetch = globalThis.fetch
		// @ts-ignore
		globalThis.fetch = mockFetch

		await expect(capturePostHogEvent({ event: "app_started", distinctId: testDeviceId })).resolves.toBeUndefined()

		// @ts-ignore
		globalThis.fetch = originalFetch
	})

	it("handles missing optional properties gracefully", async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		// @ts-ignore
		const originalFetch = globalThis.fetch
		// @ts-ignore
		globalThis.fetch = mockFetch

		// @ts-ignore
		await capturePostHogEvent({ event: "minimal_event", distinctId: testDeviceId })

		expect(mockFetch).toHaveBeenCalledOnce()
		expect(mockFetch.mock.calls[0]).toBeDefined()
		const [, options] = mockFetch.mock.calls[0]
		const body = JSON.parse(options.body as string)
		expect(body.properties).toEqual({})

		// @ts-ignore
		globalThis.fetch = originalFetch
	})
})
