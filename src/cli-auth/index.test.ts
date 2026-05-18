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
