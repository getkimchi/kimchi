import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../utils/http.js", () => ({
	fetchWithRetry: (
		url: string,
		init?: RequestInit,
		options?: { timeoutMs?: number; signal?: AbortSignal; fetchImpl?: typeof fetch },
	) => {
		const ctrl = new AbortController()
		if (options?.timeoutMs) {
			setTimeout(() => ctrl.abort(), options.timeoutMs)
		}
		const signals = [ctrl.signal, options?.signal, init?.signal].filter(Boolean) as AbortSignal[]
		const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
		return globalThis.fetch(url, { ...init, signal })
	},
}))

// Mock browser-pool to control Playwright availability.
vi.mock("./browser-pool.js", () => ({
	getBrowser: vi.fn(),
}))

import { getBrowser } from "./browser-pool.js"
import { FetchError, fetchPage } from "./page-fetcher.js"

const getBrowserMock = getBrowser as unknown as MockInstance

describe("fetchPage — native fetch fallback", () => {
	let fetchSpy: MockInstance

	beforeEach(() => {
		// Simulate Playwright not installed — getBrowser returns null.
		getBrowserMock.mockResolvedValue(null)
		fetchSpy = vi.spyOn(globalThis, "fetch")
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function mockResponse(body: string, init?: ResponseInit & { url?: string }) {
		const headers = new Headers(init?.headers)
		if (!headers.has("content-type")) {
			headers.set("content-type", "text/html; charset=utf-8")
		}
		const response = new Response(body, { ...init, headers })
		// Override the url property to simulate redirect resolution
		if (init?.url) {
			Object.defineProperty(response, "url", { value: init.url })
		}
		return response
	}

	describe("successful fetches", () => {
		it("returns HTML body with metadata", async () => {
			fetchSpy.mockResolvedValue(mockResponse("<h1>Hello</h1>", { url: "https://example.com/" }))

			const result = await fetchPage("https://example.com/")
			expect(result.body).toBe("<h1>Hello</h1>")
			expect(result.contentType).toBe("text/html; charset=utf-8")
			expect(result.statusCode).toBe(200)
			expect(result.isHTML).toBe(true)
		})

		it("returns final URL after redirect", async () => {
			fetchSpy.mockResolvedValue(mockResponse("<p>Redirected</p>", { url: "https://example.com/final" }))

			const result = await fetchPage("https://example.com/old")
			expect(result.finalURL).toBe("https://example.com/final")
		})

		it("returns JSON content as-is", async () => {
			const json = '{"key": "value"}'
			fetchSpy.mockResolvedValue(
				mockResponse(json, {
					headers: { "content-type": "application/json" },
					url: "https://api.example.com/data",
				}),
			)

			const result = await fetchPage("https://api.example.com/data")
			expect(result.body).toBe(json)
			expect(result.isHTML).toBe(false)
		})

		it("returns XML content as-is", async () => {
			const xml = "<root><item>1</item></root>"
			fetchSpy.mockResolvedValue(
				mockResponse(xml, {
					headers: { "content-type": "application/xml" },
					url: "https://example.com/feed.xml",
				}),
			)

			const result = await fetchPage("https://example.com/feed.xml")
			expect(result.body).toBe(xml)
			expect(result.isHTML).toBe(false)
		})

		it("returns plain text as-is", async () => {
			fetchSpy.mockResolvedValue(
				mockResponse("Hello, world!", {
					headers: { "content-type": "text/plain" },
					url: "https://example.com/file.txt",
				}),
			)

			const result = await fetchPage("https://example.com/file.txt")
			expect(result.body).toBe("Hello, world!")
			expect(result.isHTML).toBe(false)
		})

		it("includes fallback warning when using native fetch", async () => {
			fetchSpy.mockResolvedValue(mockResponse("<h1>Hello</h1>", { url: "https://example.com/" }))

			const result = await fetchPage("https://example.com/")
			expect(result.fallbackWarning).toBeDefined()
			expect(result.fallbackWarning).toContain("Playwright is not installed")
			expect(result.fallbackWarning).toContain("npx playwright install chromium")
		})
	})

	describe("HTTP errors", () => {
		it("throws FetchError for 404", async () => {
			fetchSpy.mockResolvedValue(
				mockResponse("Not Found", { status: 404, statusText: "Not Found", url: "https://example.com/missing" }),
			)

			await expect(fetchPage("https://example.com/missing")).rejects.toThrow(FetchError)
			await expect(fetchPage("https://example.com/missing")).rejects.toThrow("HTTP 404")
		})

		it("throws FetchError for 500", async () => {
			fetchSpy.mockResolvedValue(
				mockResponse("Internal Server Error", {
					status: 500,
					statusText: "Internal Server Error",
					url: "https://example.com/error",
				}),
			)

			try {
				await fetchPage("https://example.com/error")
				expect.unreachable("should have thrown")
			} catch (err) {
				expect(err).toBeInstanceOf(FetchError)
				expect((err as FetchError).category).toBe("http")
				expect((err as FetchError).message).toContain("500")
			}
		})

		it("throws FetchError for 403", async () => {
			fetchSpy.mockResolvedValue(
				mockResponse("Forbidden", { status: 403, statusText: "Forbidden", url: "https://example.com/" }),
			)

			try {
				await fetchPage("https://example.com/")
				expect.unreachable("should have thrown")
			} catch (err) {
				expect(err).toBeInstanceOf(FetchError)
				expect((err as FetchError).category).toBe("http")
			}
		})
	})

	describe("network errors", () => {
		it("categorizes DNS failure", async () => {
			fetchSpy.mockRejectedValue(new Error("getaddrinfo ENOTFOUND no-such-host.example"))

			try {
				await fetchPage("https://no-such-host.example/")
				expect.unreachable("should have thrown")
			} catch (err) {
				expect(err).toBeInstanceOf(FetchError)
				expect((err as FetchError).category).toBe("network")
				expect((err as FetchError).message).toContain("DNS")
			}
		})

		it("categorizes connection refused", async () => {
			fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"))

			try {
				await fetchPage("https://example.com:12345/")
				expect.unreachable("should have thrown")
			} catch (err) {
				expect(err).toBeInstanceOf(FetchError)
				expect((err as FetchError).category).toBe("network")
				expect((err as FetchError).message).toContain("Connection refused")
			}
		})

		it("categorizes connection reset", async () => {
			fetchSpy.mockRejectedValue(new Error("ECONNRESET"))

			try {
				await fetchPage("https://example.com/")
				expect.unreachable("should have thrown")
			} catch (err) {
				expect(err).toBeInstanceOf(FetchError)
				expect((err as FetchError).category).toBe("network")
				expect((err as FetchError).message).toContain("Connection reset")
			}
		})

		it("categorizes generic network error", async () => {
			fetchSpy.mockRejectedValue(new Error("Something weird happened"))

			try {
				await fetchPage("https://example.com/")
				expect.unreachable("should have thrown")
			} catch (err) {
				expect(err).toBeInstanceOf(FetchError)
				expect((err as FetchError).category).toBe("network")
			}
		})
	})

	describe("timeout handling", () => {
		it("throws timeout error when request exceeds timeout", async () => {
			fetchSpy.mockImplementation(
				(_url: string, init?: RequestInit) =>
					new Promise((_resolve, reject) => {
						// Simulate the abort signal triggering
						init?.signal?.addEventListener("abort", () => {
							const err = new DOMException("The operation was aborted.", "AbortError")
							reject(err)
						})
					}),
			)

			try {
				await fetchPage("https://slow.example.com/", { timeoutSeconds: 0.05 })
				expect.unreachable("should have thrown")
			} catch (err) {
				expect(err).toBeInstanceOf(FetchError)
				expect((err as FetchError).category).toBe("timeout")
				expect((err as FetchError).message).toContain("timed out")
			}
		})
	})

	describe("binary content rejection", () => {
		it("rejects image/png", async () => {
			fetchSpy.mockResolvedValue(
				mockResponse("binary data", {
					headers: { "content-type": "image/png" },
					url: "https://example.com/image.png",
				}),
			)

			try {
				await fetchPage("https://example.com/image.png")
				expect.unreachable("should have thrown")
			} catch (err) {
				expect(err).toBeInstanceOf(FetchError)
				expect((err as FetchError).category).toBe("binary")
				expect((err as FetchError).message).toContain("binary")
			}
		})

		it("rejects application/pdf", async () => {
			fetchSpy.mockResolvedValue(
				mockResponse("pdf bytes", {
					headers: { "content-type": "application/pdf" },
					url: "https://example.com/doc.pdf",
				}),
			)

			try {
				await fetchPage("https://example.com/doc.pdf")
				expect.unreachable("should have thrown")
			} catch (err) {
				expect(err).toBeInstanceOf(FetchError)
				expect((err as FetchError).category).toBe("binary")
			}
		})

		it("rejects application/octet-stream", async () => {
			fetchSpy.mockResolvedValue(
				mockResponse("bytes", {
					headers: { "content-type": "application/octet-stream" },
					url: "https://example.com/file.bin",
				}),
			)

			try {
				await fetchPage("https://example.com/file.bin")
				expect.unreachable("should have thrown")
			} catch (err) {
				expect(err).toBeInstanceOf(FetchError)
				expect((err as FetchError).category).toBe("binary")
			}
		})
	})

	describe("response size limits", () => {
		it("rejects response when Content-Length exceeds 5MB", async () => {
			fetchSpy.mockResolvedValue(
				mockResponse("small body", {
					headers: {
						"content-type": "text/html",
						"content-length": String(6 * 1024 * 1024),
					},
					url: "https://example.com/huge",
				}),
			)

			try {
				await fetchPage("https://example.com/huge")
				expect.unreachable("should have thrown")
			} catch (err) {
				expect(err).toBeInstanceOf(FetchError)
				expect((err as FetchError).category).toBe("too_large")
				expect((err as FetchError).message).toContain("5MB")
			}
		})
	})
})

describe("fetchPage — Playwright path", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	function mockPage(overrides: {
		gotoResponse?: {
			status?: number
			statusText?: string
			headers?: Record<string, string>
			body?: Buffer
		}
		url?: string
		content?: string
		textContent?: string
		gotoError?: Error
	}) {
		const resp = overrides.gotoResponse ?? {}
		const mockResponse = {
			status: () => resp.status ?? 200,
			statusText: () => resp.statusText ?? "OK",
			headers: () => resp.headers ?? { "content-type": "text/html; charset=utf-8" },
			body: () => Promise.resolve(resp.body ?? Buffer.from("")),
		}

		const page = {
			goto: overrides.gotoError
				? vi.fn().mockRejectedValue(overrides.gotoError)
				: vi.fn().mockResolvedValue(mockResponse),
			url: vi.fn().mockReturnValue(overrides.url ?? "https://example.com/"),
			content: vi.fn().mockResolvedValue(overrides.content ?? "<html><body><h1>Test</h1></body></html>"),
			textContent: vi.fn().mockResolvedValue(overrides.textContent ?? "Test"),
			waitForLoadState: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
		}

		const browser = {
			newPage: vi.fn().mockResolvedValue(page),
			isConnected: () => true,
		}

		getBrowserMock.mockResolvedValue(browser)

		return { browser, page, mockResponse }
	}

	it("returns HTML content via Playwright", async () => {
		const { page } = mockPage({
			content: "<html><body><h1>Hello Playwright</h1></body></html>",
		})

		const result = await fetchPage("https://example.com/")
		expect(result.body).toBe("<html><body><h1>Hello Playwright</h1></body></html>")
		expect(result.isHTML).toBe(true)
		expect(result.fallbackWarning).toBeUndefined()
		expect(page.close).toHaveBeenCalled()
	})

	it("uses page.textContent for format: text", async () => {
		const { page } = mockPage({
			textContent: "Hello plain text from Playwright",
		})

		const result = await fetchPage("https://example.com/", { format: "text" })
		expect(result.body).toBe("Hello plain text from Playwright")
		expect(page.textContent).toHaveBeenCalledWith("body")
		expect(page.content).not.toHaveBeenCalled()
	})

	it("uses page.content for format: markdown", async () => {
		const { page } = mockPage({
			content: "<html><body><h1>Markdown source</h1></body></html>",
		})

		const result = await fetchPage("https://example.com/", { format: "markdown" })
		expect(result.body).toContain("Markdown source")
		expect(page.content).toHaveBeenCalled()
		expect(page.textContent).not.toHaveBeenCalled()
	})

	it("uses page.content for format: html", async () => {
		const { page } = mockPage({
			content: "<html><body><h1>Raw HTML</h1></body></html>",
		})

		const result = await fetchPage("https://example.com/", { format: "html" })
		expect(result.body).toContain("Raw HTML")
		expect(page.content).toHaveBeenCalled()
	})

	it("reports final URL from Playwright page", async () => {
		mockPage({
			url: "https://example.com/final-destination",
		})

		const result = await fetchPage("https://example.com/redirect")
		expect(result.finalURL).toBe("https://example.com/final-destination")
	})

	it("throws FetchError on HTTP error", async () => {
		mockPage({
			gotoResponse: { status: 404, statusText: "Not Found" },
		})

		try {
			await fetchPage("https://example.com/missing")
			expect.unreachable("should have thrown")
		} catch (err) {
			expect(err).toBeInstanceOf(FetchError)
			expect((err as FetchError).category).toBe("http")
			expect((err as FetchError).message).toContain("404")
		}
	})

	it("throws FetchError on timeout", async () => {
		mockPage({
			gotoError: new Error("Timeout 30000ms exceeded"),
		})

		try {
			await fetchPage("https://slow.example.com/", { timeoutSeconds: 5 })
			expect.unreachable("should have thrown")
		} catch (err) {
			expect(err).toBeInstanceOf(FetchError)
			expect((err as FetchError).category).toBe("timeout")
			expect((err as FetchError).message).toContain("timed out")
		}
	})

	it("classifies TimeoutError by error name even without 'timeout' in message", async () => {
		const err = new Error("Navigation failed")
		err.name = "TimeoutError"
		mockPage({ gotoError: err })

		try {
			await fetchPage("https://slow.example.com/", { timeoutSeconds: 5 })
			expect.unreachable("should have thrown")
		} catch (err) {
			expect(err).toBeInstanceOf(FetchError)
			expect((err as FetchError).category).toBe("timeout")
			expect((err as FetchError).message).toContain("timed out")
		}
	})

	it("throws FetchError on DNS failure", async () => {
		mockPage({
			gotoError: new Error("net::ERR_NAME_NOT_RESOLVED"),
		})

		try {
			await fetchPage("https://nonexistent.example/")
			expect.unreachable("should have thrown")
		} catch (err) {
			expect(err).toBeInstanceOf(FetchError)
			expect((err as FetchError).category).toBe("network")
			expect((err as FetchError).message).toContain("DNS")
		}
	})

	it("rejects binary content-type via Playwright", async () => {
		mockPage({
			gotoResponse: {
				status: 200,
				headers: { "content-type": "image/png" },
			},
		})

		try {
			await fetchPage("https://example.com/image.png")
			expect.unreachable("should have thrown")
		} catch (err) {
			expect(err).toBeInstanceOf(FetchError)
			expect((err as FetchError).category).toBe("binary")
		}
	})

	it("closes page even on error", async () => {
		const { page } = mockPage({
			gotoResponse: { status: 500, statusText: "Server Error" },
		})

		try {
			await fetchPage("https://example.com/error")
		} catch {
			// expected
		}
		expect(page.close).toHaveBeenCalled()
	})

	it("waits for networkidle after load", async () => {
		const { page } = mockPage({})

		await fetchPage("https://example.com/")
		expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", expect.any(Object))
	})

	it("returns non-HTML text content via Playwright", async () => {
		mockPage({
			gotoResponse: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: Buffer.from('{"hello":"world"}'),
			},
		})

		const result = await fetchPage("https://api.example.com/data")
		expect(result.body).toBe('{"hello":"world"}')
		expect(result.isHTML).toBe(false)
	})
})
