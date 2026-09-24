import { describe, expect, it } from "vitest"
import {
	anthropicBaseUrl,
	billingUrl,
	cliAuthUrl,
	DEFAULT_REGION,
	experimentalOpenAiBaseUrl,
	getRegion,
	isRegionId,
	keyValidationUrl,
	openAiBaseUrl,
	platformApiUrl,
	pricingUrl,
	REGIONS,
	routeUrl,
	searchUrl,
	statsApiBaseUrl,
	telemetryLogsUrl,
	telemetryMetricsUrl,
} from "./regions.js"

const us = REGIONS.us
const eu = REGIONS.eu

describe("REGIONS", () => {
	it("declares us and eu", () => {
		expect(Object.keys(REGIONS).sort()).toEqual(["eu", "us"])
	})

	it("us registry entry matches today's hardcoded production hosts", () => {
		expect(us.webAppUrl).toBe("https://app.kimchi.dev")
		expect(us.llmBaseUrl).toBe("https://llm.kimchi.dev")
		expect(us.castApiUrl).toBe("https://api.cast.ai")
	})

	it("eu registry entry points at the eu hosts", () => {
		expect(eu.webAppUrl).toBe("https://app.eu.kimchi.dev")
		expect(eu.llmBaseUrl).toBe("https://llm.eu.kimchi.dev")
		expect(eu.castApiUrl).toBe("https://api.eu.cast.ai")
	})
})

describe("derivation helpers — us golden URLs", () => {
	// This table is a deliberate tripwire: it must match exactly the URLs
	// hardcoded across the codebase today (see .kimchi/docs/endpoints-inventory.md).
	it("returns exactly the URLs used today", () => {
		expect({
			cliAuthUrl: cliAuthUrl(us),
			platformApiUrl: platformApiUrl(us),
			openAiBaseUrl: openAiBaseUrl(us),
			anthropicBaseUrl: anthropicBaseUrl(us),
			experimentalOpenAiBaseUrl: experimentalOpenAiBaseUrl(us),
			searchUrl: searchUrl(us),
			routeUrl: routeUrl(us),
			billingUrl: billingUrl(us),
			pricingUrl: pricingUrl(us),
			keyValidationUrl: keyValidationUrl(us),
			telemetryLogsUrl: telemetryLogsUrl(us),
			telemetryMetricsUrl: telemetryMetricsUrl(us),
			statsApiBaseUrl: statsApiBaseUrl(us),
		}).toEqual({
			cliAuthUrl: "https://app.kimchi.dev/cli-auth",
			platformApiUrl: "https://app.kimchi.dev/api",
			openAiBaseUrl: "https://llm.kimchi.dev/openai/v1",
			anthropicBaseUrl: "https://llm.kimchi.dev/anthropic",
			experimentalOpenAiBaseUrl: "https://llm.kimchi.dev/experimental/openai/v1",
			searchUrl: "https://llm.kimchi.dev/v1/search",
			routeUrl: "https://llm.kimchi.dev/v1/route",
			billingUrl: "https://app.kimchi.dev/billing",
			pricingUrl: "https://app.kimchi.dev/pricing",
			keyValidationUrl: "https://api.cast.ai/v1/llm/openai/supported-providers",
			telemetryLogsUrl: "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest",
			telemetryMetricsUrl: "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			statsApiBaseUrl: "https://api.cast.ai",
		})
	})
})

describe("derivation helpers — eu variants", () => {
	it("derives eu URLs from the eu bases", () => {
		expect(cliAuthUrl(eu)).toBe("https://app.eu.kimchi.dev/cli-auth")
		expect(platformApiUrl(eu)).toBe("https://app.eu.kimchi.dev/api")
		expect(openAiBaseUrl(eu)).toBe("https://llm.eu.kimchi.dev/openai/v1")
		expect(anthropicBaseUrl(eu)).toBe("https://llm.eu.kimchi.dev/anthropic")
		expect(experimentalOpenAiBaseUrl(eu)).toBe("https://llm.eu.kimchi.dev/experimental/openai/v1")
		expect(searchUrl(eu)).toBe("https://llm.eu.kimchi.dev/v1/search")
		expect(routeUrl(eu)).toBe("https://llm.eu.kimchi.dev/v1/route")
		expect(billingUrl(eu)).toBe("https://app.eu.kimchi.dev/billing")
		expect(pricingUrl(eu)).toBe("https://app.eu.kimchi.dev/pricing")
		expect(keyValidationUrl(eu)).toBe("https://api.eu.cast.ai/v1/llm/openai/supported-providers")
		expect(telemetryLogsUrl(eu)).toBe("https://api.eu.cast.ai/ai-optimizer/v1beta/logs:ingest")
		expect(telemetryMetricsUrl(eu)).toBe("https://api.eu.cast.ai/ai-optimizer/v1beta/metrics:ingest")
		expect(statsApiBaseUrl(eu)).toBe("https://api.eu.cast.ai")
	})
})

describe("isRegionId", () => {
	it("accepts known region ids", () => {
		expect(isRegionId("us")).toBe(true)
		expect(isRegionId("eu")).toBe(true)
	})

	it("rejects unknown ids and non-strings", () => {
		expect(isRegionId("moon")).toBe(false)
		expect(isRegionId("")).toBe(false)
		expect(isRegionId("US")).toBe(false)
		expect(isRegionId(undefined)).toBe(false)
		expect(isRegionId(null)).toBe(false)
		expect(isRegionId(42)).toBe(false)
	})
})

describe("getRegion", () => {
	it("returns the region for known ids", () => {
		expect(getRegion("us")).toBe(us)
		expect(getRegion("eu")).toBe(eu)
	})

	it("falls back to the default region for unknown input", () => {
		expect(getRegion("moon")).toBe(REGIONS[DEFAULT_REGION])
		expect(getRegion(undefined)).toBe(REGIONS[DEFAULT_REGION])
	})
})
