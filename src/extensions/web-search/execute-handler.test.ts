import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as config from "../../config.js"
import { DEFAULT_LIMIT, SEARCH_ENDPOINT, type SearchResponse, executeWebSearch } from "./execute-handler.js"

vi.mock("../../config.js", () => ({ readApiKeyFromConfigFile: vi.fn() }))
vi.mock("../../utils/http.js", () => ({
	fetchWithRetry: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
}))

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}): void {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (key: string) => headers[key] ?? null },
			json: () => Promise.resolve(body),
		}),
	)
}

function makeSources(count: number) {
	return Array.from({ length: count }, (_, i) => ({
		title: `Source ${i + 1}`,
		url: `https://example.com/${i + 1}`,
		snippet: `Snippet for source ${i + 1}`,
	}))
}

beforeEach(() => {
	vi.mocked(config.readApiKeyFromConfigFile).mockReturnValue("test-key-123")
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe("executeWebSearch", () => {
	describe("API key validation", () => {
		it("throws a human-readable error when no API key is set in config", async () => {
			vi.mocked(config.readApiKeyFromConfigFile).mockReturnValue(undefined)

			await expect(executeWebSearch({ query: "test" })).rejects.toThrow(
				"Web search requires an API key. Run 'kimchi' and log in, or visit https://app.kimchi.dev to create a key.",
			)
		})

		it("uses API key from config file", async () => {
			vi.mocked(config.readApiKeyFromConfigFile).mockReturnValue("key-from-config-file")
			mockFetch(200, { sources: [] })

			await executeWebSearch({ query: "test" })

			const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>
			expect(headers.Authorization).toBe("Bearer key-from-config-file")
		})
	})

	describe("request building", () => {
		it("sends query and default limit when no limit provided", async () => {
			mockFetch(200, { answer: "ok", sources: [] })

			await executeWebSearch({ query: "TypeScript generics" })

			const fetchMock = vi.mocked(fetch)
			const call = fetchMock.mock.calls[0]
			const body = JSON.parse(call[1]?.body as string)
			expect(body.query).toBe("TypeScript generics")
			expect(body.limit).toBe(DEFAULT_LIMIT)
			expect(body.recency).toBeUndefined()
		})

		it("sends provided limit", async () => {
			mockFetch(200, { answer: "ok", sources: [] })

			await executeWebSearch({ query: "test", limit: 3 })

			const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
			expect(body.limit).toBe(3)
		})

		it("sends recency when provided", async () => {
			mockFetch(200, { answer: "ok", sources: [] })

			await executeWebSearch({ query: "test", recency: "week" })

			const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
			expect(body.recency).toBe("week")
		})

		it("omits recency field when not provided", async () => {
			mockFetch(200, { answer: "ok", sources: [] })

			await executeWebSearch({ query: "test" })

			const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
			expect("recency" in body).toBe(false)
		})

		it("sends Authorization header with Bearer token", async () => {
			mockFetch(200, { answer: "ok", sources: [] })

			await executeWebSearch({ query: "test" })

			const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>
			expect(headers.Authorization).toBe("Bearer test-key-123")
		})

		it("posts to the correct endpoint", async () => {
			mockFetch(200, { answer: "ok", sources: [] })

			await executeWebSearch({ query: "test" })

			expect(vi.mocked(fetch).mock.calls[0][0]).toBe(SEARCH_ENDPOINT)
		})
	})

	describe("HTTP error handling", () => {
		it("throws auth error for 401", async () => {
			mockFetch(401, {})

			await expect(executeWebSearch({ query: "test" })).rejects.toThrow("Authentication failed (401)")
		})

		it("throws auth error for 403", async () => {
			mockFetch(403, {})

			await expect(executeWebSearch({ query: "test" })).rejects.toThrow("Authentication failed (403)")
		})

		it("throws for 500", async () => {
			mockFetch(500, {})

			await expect(executeWebSearch({ query: "test" })).rejects.toThrow("Web search failed with status 500")
		})

		it("throws rate limit error for 429 after retries exhausted", async () => {
			mockFetch(429, {})

			await expect(executeWebSearch({ query: "test" })).rejects.toThrow(
				"Web search rate limited. Retries exhausted, please try again later.",
			)
		})
	})

	describe("timeout handling", () => {
		it("throws when fetch is aborted by timeout", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
			)

			await expect(executeWebSearch({ query: "test" })).rejects.toThrow("Web search timed out")
		})
	})

	describe("network error handling", () => {
		it("re-throws generic Error", async () => {
			vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")))

			await expect(executeWebSearch({ query: "test" })).rejects.toThrow("ECONNREFUSED")
		})

		it("re-throws non-Error thrown values", async () => {
			vi.stubGlobal("fetch", vi.fn().mockRejectedValue("something broke"))

			await expect(executeWebSearch({ query: "test" })).rejects.toThrow("something broke")
		})
	})

	describe("successful response formatting", () => {
		it("returns formatted text with sources", async () => {
			const data: SearchResponse = {
				sources: [{ title: "TypeScript Docs", url: "https://typescriptlang.org", snippet: "Official docs" }],
			}
			mockFetch(200, data)

			const result = await executeWebSearch({ query: "what is TypeScript" })

			expect(result.content[0].text).toContain("TypeScript Docs")
			expect(result.content[0].text).toContain("https://typescriptlang.org")
			expect(result.content[0].text).toContain("Official docs")
		})

		it("returns 'No results found.' when response has no sources", async () => {
			mockFetch(200, { sources: [] })

			const result = await executeWebSearch({ query: "xyzzy" })

			expect(result.content[0].text).toBe("No results found.")
		})

		it("returns numbered sources with title and url", async () => {
			const data: SearchResponse = {
				sources: [{ title: "Example", url: "https://example.com" }],
			}
			mockFetch(200, data)

			const result = await executeWebSearch({ query: "test" })

			expect(result.content[0].text).toContain("[1] Example")
			expect(result.content[0].text).not.toContain("## Sources")
		})

		it("numbers multiple sources sequentially", async () => {
			mockFetch(200, { sources: makeSources(3) })

			const result = await executeWebSearch({ query: "test" })
			const text = result.content[0].text
			expect(text).toContain("[1]")
			expect(text).toContain("[2]")
			expect(text).toContain("[3]")
		})
	})
})
