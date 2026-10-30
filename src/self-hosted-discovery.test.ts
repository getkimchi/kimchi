import { describe, expect, it, vi } from "vitest"
import { discoveredSelfHostedRegion, regionEndpoints } from "./regions.js"
import {
	fetchSelfHostedEndpoints,
	parseEndpointsDocument,
	SELF_HOSTED_DISCOVERY_PATH,
	selfHostedDiscoveryUrl,
} from "./self-hosted-discovery.js"

function jsonResponse(
	body: unknown,
	status = 200,
): {
	ok: boolean
	status: number
	json(): Promise<unknown>
} {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
	}
}

describe("selfHostedDiscoveryUrl", () => {
	it("appends the discovery path to the console URL", () => {
		expect(selfHostedDiscoveryUrl("https://kimchi.example.com")).toBe(
			`https://kimchi.example.com${SELF_HOSTED_DISCOVERY_PATH}`,
		)
	})

	it("tolerates trailing slashes and whitespace", () => {
		expect(selfHostedDiscoveryUrl("https://kimchi.example.com//")).toBe(
			`https://kimchi.example.com${SELF_HOSTED_DISCOVERY_PATH}`,
		)
		expect(selfHostedDiscoveryUrl(" http://localhost:8080/ ")).toBe(
			`http://localhost:8080${SELF_HOSTED_DISCOVERY_PATH}`,
		)
	})
})

describe("parseEndpointsDocument", () => {
	it("parses the happy-path document with all three keys", () => {
		expect(
			parseEndpointsDocument({
				api: "https://kimchi.example.com",
				console: "https://kimchi.example.com",
				llm: "https://llm.example.com",
			}),
		).toEqual({
			api: "https://kimchi.example.com",
			console: "https://kimchi.example.com",
			llm: "https://llm.example.com",
		})
	})

	it("normalizes trailing slashes and whitespace on every key", () => {
		expect(
			parseEndpointsDocument({
				api: " https://kimchi.example.com/ ",
				console: "https://kimchi.example.com//",
				llm: "https://llm.example.com/",
			}),
		).toEqual({
			api: "https://kimchi.example.com",
			console: "https://kimchi.example.com",
			llm: "https://llm.example.com",
		})
	})

	it("keeps explicit ports (local port-forward installs)", () => {
		expect(
			parseEndpointsDocument({
				api: "http://localhost:8080",
				console: "http://localhost:8080",
				llm: "http://llm.localhost:8080",
			}),
		).toEqual({
			api: "http://localhost:8080",
			console: "http://localhost:8080",
			llm: "http://llm.localhost:8080",
		})
	})

	it("returns undefined when any key is missing", () => {
		const base = { api: "https://kimchi.example.com", console: "https://kimchi.example.com" }
		expect(parseEndpointsDocument(base)).toBeUndefined()
		expect(
			parseEndpointsDocument({ api: "https://kimchi.example.com", llm: "https://llm.example.com" }),
		).toBeUndefined()
		expect(
			parseEndpointsDocument({ console: "https://kimchi.example.com", llm: "https://llm.example.com" }),
		).toBeUndefined()
		expect(parseEndpointsDocument({})).toBeUndefined()
	})

	it("returns undefined for non-object or invalid-URL values", () => {
		expect(parseEndpointsDocument(null)).toBeUndefined()
		expect(parseEndpointsDocument("https://kimchi.example.com")).toBeUndefined()
		expect(parseEndpointsDocument(["https://kimchi.example.com", "https://llm.example.com"])).toBeUndefined()
		expect(
			parseEndpointsDocument({
				api: "not a url",
				console: "https://kimchi.example.com",
				llm: "https://llm.example.com",
			}),
		).toBeUndefined()
		expect(
			parseEndpointsDocument({
				api: "ftp://kimchi.example.com",
				console: "https://kimchi.example.com",
				llm: "https://llm.example.com",
			}),
		).toBeUndefined()
	})

	it("ignores extra keys (forward compatibility)", () => {
		expect(
			parseEndpointsDocument({
				api: "https://kimchi.example.com",
				console: "https://kimchi.example.com",
				llm: "https://llm.example.com",
				future: "whatever",
			}),
		).toEqual({
			api: "https://kimchi.example.com",
			console: "https://kimchi.example.com",
			llm: "https://llm.example.com",
		})
	})
})

describe("fetchSelfHostedEndpoints", () => {
	it("discovers endpoints on the happy path, from an http localhost console", async () => {
		const fetchImpl = vi.fn(async (url: string) => {
			expect(url).toBe(`http://localhost:8080${SELF_HOSTED_DISCOVERY_PATH}`)
			return jsonResponse({
				api: "http://localhost:8080",
				console: "http://localhost:8080",
				llm: "http://llm.localhost:8080",
			})
		})

		const result = await fetchSelfHostedEndpoints("http://localhost:8080/", { fetchImpl })

		expect(result).toEqual({
			status: "discovered",
			endpoints: {
				api: "http://localhost:8080",
				console: "http://localhost:8080",
				llm: "http://llm.localhost:8080",
			},
		})
		expect(fetchImpl).toHaveBeenCalledOnce()
	})

	it("reports 404 as unavailable with a reason naming the path", async () => {
		const result = await fetchSelfHostedEndpoints("https://kimchi.example.com", {
			fetchImpl: async () => jsonResponse("not found", 404),
		})

		expect(result.status).toBe("unavailable")
		if (result.status === "unavailable") {
			expect(result.reason).toContain("404")
			expect(result.reason).toContain(SELF_HOSTED_DISCOVERY_PATH)
		}
	})

	it("reports other non-200 statuses as unavailable", async () => {
		const result = await fetchSelfHostedEndpoints("https://kimchi.example.com", {
			fetchImpl: async () => jsonResponse("oops", 503),
		})

		expect(result.status).toBe("unavailable")
		if (result.status === "unavailable") expect(result.reason).toContain("503")
	})

	it("reports an incomplete document as unavailable", async () => {
		const result = await fetchSelfHostedEndpoints("https://kimchi.example.com", {
			fetchImpl: async () => jsonResponse({ api: "https://kimchi.example.com" }),
		})

		expect(result.status).toBe("unavailable")
		if (result.status === "unavailable") expect(result.reason).toContain("api, console, or llm")
	})

	it("reports network failures as unavailable, without throwing", async () => {
		const result = await fetchSelfHostedEndpoints("https://kimchi.example.com", {
			fetchImpl: async () => {
				throw new Error("getaddrinfo ENOTFOUND kimchi.example.com")
			},
		})

		expect(result.status).toBe("unavailable")
		if (result.status === "unavailable") expect(result.reason).toContain("ENOTFOUND")
	})

	it("reports invalid JSON bodies as an incomplete document, without throwing", async () => {
		// Pre-discovery installs serve the SPA for unknown paths, so
		// /env/endpoints.json can answer 200 with an HTML payload.
		const result = await fetchSelfHostedEndpoints("https://kimchi.example.com", {
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				json: () => Promise.reject(new SyntaxError("Unexpected token '<', \"<!doctype \"... is not valid JSON")),
			}),
		})

		expect(result).toEqual({
			status: "unavailable",
			cause: "incomplete",
			reason: expect.stringContaining("did not return valid JSON"),
		})
	})
})

describe("discovered endpoints → region derivation (the llm origin-only rule)", () => {
	it("derives the API shapes by appending paths to the llm ORIGIN", () => {
		const region = discoveredSelfHostedRegion({
			api: "https://kimchi.example.com",
			console: "https://kimchi.example.com",
			llm: "https://llm.example.com",
		})

		expect(region.webAppUrl).toBe("https://kimchi.example.com")
		expect(region.llmBaseUrl).toBe("https://llm.example.com")
		expect(region.castApiUrl).toBe("https://kimchi.example.com")

		const endpoints = regionEndpoints(region)
		// The contract: the llm value is the ORIGIN ONLY — the OpenAI base must
		// be <llm>/openai/v1, the Anthropic SDK base <llm>/anthropic (that SDK
		// appends /v1/messages itself), search at <llm>/v1/search.
		expect(endpoints.openAiBaseUrl).toBe("https://llm.example.com/openai/v1")
		expect(endpoints.anthropicBaseUrl).toBe("https://llm.example.com/anthropic")
		expect(endpoints.searchUrl).toBe("https://llm.example.com/v1/search")
		// REST API paths live at the root of the api origin.
		expect(endpoints.keyValidationUrl).toBe("https://kimchi.example.com/v1/llm/openai/supported-providers")
		expect(endpoints.telemetryLogsUrl).toBe("https://kimchi.example.com/ai-optimizer/v1beta/logs:ingest")
		// The platform API is the api origin directly (alias of castApiUrl) —
		// the console host carries no API traffic.
		expect(endpoints.platformApiUrl).toBe("https://kimchi.example.com")
		expect(endpoints.webAppUrl).toBe("https://kimchi.example.com")
	})

	it("supports a localhost port-forward install with separate loopback hosts", () => {
		const endpoints = regionEndpoints(
			discoveredSelfHostedRegion({
				api: "http://localhost:8080",
				console: "http://localhost:8080",
				llm: "http://llm.localhost:8080",
			}),
		)

		expect(endpoints.openAiBaseUrl).toBe("http://llm.localhost:8080/openai/v1")
		expect(endpoints.anthropicBaseUrl).toBe("http://llm.localhost:8080/anthropic")
		expect(endpoints.webAppUrl).toBe("http://localhost:8080")
		expect(endpoints.platformApiUrl).toBe("http://localhost:8080")
	})
})
