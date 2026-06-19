import { afterEach, describe, expect, it, vi } from "vitest"
import { waitForWorkspaceReady } from "./readiness.js"

describe("waitForWorkspaceReady", () => {
	function mockFetch(responses: Array<{ ok: boolean; status: number } | Error>) {
		let i = 0
		const mockFn = vi.fn()
		mockFn.mockImplementation(() => {
			const resp = responses[Math.min(i++, responses.length - 1)]
			if (resp instanceof Error) {
				return Promise.reject(resp)
			}
			return Promise.resolve({
				ok: resp.ok,
				status: resp.status,
				statusText: resp.ok ? "OK" : "Error",
			} as Response)
		})
		vi.stubGlobal("fetch", mockFn)
		return mockFn
	}

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("resolves on the first probe that returns 200", async () => {
		const fetchMock = mockFetch([{ ok: true, status: 200 }])

		const promise = waitForWorkspaceReady({
			wsUrl: "wss://h.example.com/",
			connectToken: "tok-1",
			pollIntervalMs: 1,
			probeTimeoutMs: 1000,
		})

		await expect(promise).resolves.toBeUndefined()

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenCalledWith("https://h.example.com/startupcompletedz", {
			method: "GET",
			headers: { Authorization: "Bearer tok-1" },
			signal: expect.any(AbortSignal),
		})
	})

	it("retries when the first probe gets a non-200", async () => {
		const fetchMock = mockFetch([
			{ ok: false, status: 503 },
			{ ok: true, status: 200 },
		])

		const promise = waitForWorkspaceReady({
			wsUrl: "wss://h.example.com/",
			connectToken: "tok",
			pollIntervalMs: 1,
			probeTimeoutMs: 1000,
		})

		await expect(promise).resolves.toBeUndefined()
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("fires onTick for each probe with lastError on failure", async () => {
		const ticks: Array<{ elapsedMs: number; lastError?: string }> = []
		const fetchMock = mockFetch([
			{ ok: false, status: 503 },
			{ ok: true, status: 200 },
		])

		const promise = waitForWorkspaceReady({
			wsUrl: "wss://h.example.com/",
			connectToken: "tok",
			pollIntervalMs: 1,
			probeTimeoutMs: 1000,
			onTick: (t) => ticks.push(t),
		})

		await promise

		expect(ticks).toHaveLength(2)
		expect(ticks[0].lastError).toMatch(/HTTP 503/)
		expect(ticks[1].lastError).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("rejects on overall timeout with the last probe error in the message", async () => {
		mockFetch([{ ok: false, status: 503 }])

		const promise = waitForWorkspaceReady({
			wsUrl: "wss://h.example.com/",
			connectToken: "tok",
			pollIntervalMs: 5,
			probeTimeoutMs: 2,
			timeoutMs: 30,
		})

		await expect(promise).rejects.toThrow(/HTTP 503/)
	})

	it("rejects when the abort signal fires", async () => {
		const ctrl = new AbortController()

		const promise = waitForWorkspaceReady({
			wsUrl: "wss://h.example.com/",
			connectToken: "tok",
			pollIntervalMs: 60_000,
			probeTimeoutMs: 60_000,
			signal: ctrl.signal,
		})

		setTimeout(() => ctrl.abort(), 5)
		await expect(promise).rejects.toThrow(/[Aa]borted/)
	})
})
