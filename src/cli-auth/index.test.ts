import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const openMock = vi.hoisted(() => vi.fn<(_url: string) => Promise<void>>())
vi.mock("open", () => ({ default: openMock }))

const { authenticateViaBrowser } = await import("./index.js")

describe("authenticateViaBrowser", () => {
	beforeEach(() => {
		openMock.mockClear()
		vi.spyOn(console, "log").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("returns the token when the callback succeeds", async () => {
		openMock.mockResolvedValue(undefined)

		const promise = authenticateViaBrowser({ webAppUrl: "https://app.kimchi.dev" })
		await vi.waitFor(() => {
			expect(openMock).toHaveBeenCalledTimes(1)
		})

		expect(openMock).toHaveBeenCalledTimes(1)
		const browserUrl = openMock.mock.calls[0][0]
		expect(browserUrl).toMatch(/https:\/\/app\.kimchi\.dev\/cli-auth\?callback=/)
		expect(browserUrl).toMatch(/&state=[0-9a-f]{64}/)

		const urlObj = new URL(browserUrl)
		const callbackUrl = decodeURIComponent(urlObj.searchParams.get("callback") || "")
		const state = urlObj.searchParams.get("state") || ""

		const res = await fetch(`${callbackUrl}?token=castai_v1_test_token_123&state=${state}`)
		expect(res.status).toBe(200)

		const result = await promise
		expect(result.token).toBe("castai_v1_test_token_123")
	})

	it("aborts the callback wait when the signal fires (e.g. login dialog cancelled)", async () => {
		openMock.mockResolvedValue(undefined)
		const controller = new AbortController()

		const promise = authenticateViaBrowser({ webAppUrl: "https://app.kimchi.dev", signal: controller.signal })
		let rejection: Error | undefined
		promise.catch((err) => {
			rejection = err instanceof Error ? err : new Error(String(err))
		})
		await vi.waitFor(() => {
			expect(openMock).toHaveBeenCalledTimes(1)
		})

		// Abort instead of completing the browser callback; the server must tear down
		// and the wait must reject rather than hang until the 5-minute timeout.
		controller.abort()

		await vi.waitFor(() => {
			expect(rejection).toBeInstanceOf(Error)
		})
		expect((rejection as Error).message).toMatch(/cancelled/i)
	})

	it("does not open the browser when the signal is already aborted", async () => {
		openMock.mockResolvedValue(undefined)
		const controller = new AbortController()
		controller.abort()

		await expect(
			authenticateViaBrowser({ webAppUrl: "https://app.kimchi.dev", signal: controller.signal }),
		).rejects.toThrow(/cancelled/i)
		expect(openMock).not.toHaveBeenCalled()
	})

	it("skips the browser opener under the e2e seam (login tests must not pop a real browser)", async () => {
		openMock.mockResolvedValue(undefined)
		// vitest sets VITEST, so the seam gate is unlocked in this worker.
		process.env.KIMCHI_E2E_FAKE_BROWSER_OPEN = "1"
		const logSpy = vi.spyOn(console, "log")

		try {
			const controller = new AbortController()
			const promise = authenticateViaBrowser({
				webAppUrl: "https://app.kimchi.dev",
				signal: controller.signal,
			})
			await vi.waitFor(() => {
				// The quiet-path hint replaces the opener under the seam.
				expect(
					logSpy.mock.calls.some((call) => String(call[0]).includes("If the browser did not open automatically")),
				).toBe(true)
			})
			expect(openMock).not.toHaveBeenCalled()
			controller.abort()
			await expect(promise).rejects.toThrow(/cancelled/i)
		} finally {
			delete process.env.KIMCHI_E2E_FAKE_BROWSER_OPEN
		}
	})

	it("throws when the browser callback returns an error", async () => {
		openMock.mockResolvedValue(undefined)

		const promise = authenticateViaBrowser({ webAppUrl: "https://app.kimchi.dev" })
		let rejection: Error | undefined
		promise.catch((err) => {
			rejection = err instanceof Error ? err : new Error(String(err))
		})
		await vi.waitFor(() => {
			expect(openMock).toHaveBeenCalledTimes(1)
		})

		expect(openMock).toHaveBeenCalledTimes(1)
		const browserUrl = openMock.mock.calls[0][0]
		const urlObj = new URL(browserUrl)
		const callbackUrl = decodeURIComponent(urlObj.searchParams.get("callback") || "")
		const state = urlObj.searchParams.get("state") || ""

		const res = await fetch(`${callbackUrl}?error=access_denied&error_description=User+cancelled&state=${state}`)
		await res.text()

		expect(rejection).toBeInstanceOf(Error)
		expect((rejection as Error).message).toMatch(/User cancelled/)
	})
})
