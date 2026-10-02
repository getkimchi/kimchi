import { describe, expect, it } from "vitest"
import { withExperimentalFeatures } from "./extensions/experimental.js"
import {
	anthropicBaseUrl,
	experimentalOpenAiBaseUrl,
	isRegionId,
	keyValidationUrl,
	normalizeSelfHostedBaseUrl,
	openAiBaseUrl,
	platformApiUrl,
	REGIONS,
	regionEndpoints,
	searchUrl,
	selectableRegions,
	selfHostedRegion,
	telemetryLogsUrl,
	telemetryMetricsUrl,
} from "./regions.js"

const us = REGIONS.us
const eu = REGIONS.eu
const selfHosted = selfHostedRegion("https://kimchi.example.com")

describe("REGIONS", () => {
	it("declares us, eu, and self-hosted", () => {
		expect(Object.keys(REGIONS).sort()).toEqual(["eu", "self-hosted", "us"])
	})

	it("keys each entry by its own id", () => {
		for (const [key, region] of Object.entries(REGIONS)) {
			expect(region.id).toBe(key)
		}
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

	it("self-hosted registry entry is a placeholder with empty URLs", () => {
		// The real entry is built per install by selfHostedRegion(base); the
		// registry entry only anchors the id/label and keeps RegionId complete.
		expect(REGIONS["self-hosted"].label).toBe("Self-hosted")
		expect(REGIONS["self-hosted"].webAppUrl).toBe("")
		expect(REGIONS["self-hosted"].llmBaseUrl).toBe("")
		expect(REGIONS["self-hosted"].castApiUrl).toBe("")
	})
})

describe("derivation helpers — us golden URLs", () => {
	// This table is a deliberate tripwire: it must match exactly the URLs
	// hardcoded across the codebase today (see .kimchi/docs/endpoints-inventory.md).
	it("returns exactly the URLs used today", () => {
		expect({
			platformApiUrl: platformApiUrl(us),
			openAiBaseUrl: openAiBaseUrl(us),
			anthropicBaseUrl: anthropicBaseUrl(us),
			experimentalOpenAiBaseUrl: experimentalOpenAiBaseUrl(us),
			searchUrl: searchUrl(us),
			keyValidationUrl: keyValidationUrl(us),
			telemetryLogsUrl: telemetryLogsUrl(us),
			telemetryMetricsUrl: telemetryMetricsUrl(us),
		}).toEqual({
			platformApiUrl: "https://app.kimchi.dev/api",
			openAiBaseUrl: "https://llm.kimchi.dev/openai/v1",
			anthropicBaseUrl: "https://llm.kimchi.dev/anthropic",
			experimentalOpenAiBaseUrl: "https://llm.kimchi.dev/experimental/openai/v1",
			searchUrl: "https://llm.kimchi.dev/v1/search",
			keyValidationUrl: "https://api.cast.ai/v1/llm/openai/supported-providers",
			telemetryLogsUrl: "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest",
			telemetryMetricsUrl: "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
		})
	})
})

describe("derivation helpers — eu variants", () => {
	it("derives eu URLs from the eu bases", () => {
		expect(platformApiUrl(eu)).toBe("https://app.eu.kimchi.dev/api")
		expect(openAiBaseUrl(eu)).toBe("https://llm.eu.kimchi.dev/openai/v1")
		expect(anthropicBaseUrl(eu)).toBe("https://llm.eu.kimchi.dev/anthropic")
		expect(experimentalOpenAiBaseUrl(eu)).toBe("https://llm.eu.kimchi.dev/experimental/openai/v1")
		expect(searchUrl(eu)).toBe("https://llm.eu.kimchi.dev/v1/search")
		expect(keyValidationUrl(eu)).toBe("https://api.eu.cast.ai/v1/llm/openai/supported-providers")
		expect(telemetryLogsUrl(eu)).toBe("https://api.eu.cast.ai/ai-optimizer/v1beta/logs:ingest")
		expect(telemetryMetricsUrl(eu)).toBe("https://api.eu.cast.ai/ai-optimizer/v1beta/metrics:ingest")
	})
})

describe("derivation helpers — self-hosted golden URLs", () => {
	// The full endpoint inventory a self-hosted server must serve, derived
	// from ONE base URL via selfHostedRegion(base). This table is the contract
	// the self-hosted server implements — keep it in sync with any change.
	it("derives every endpoint from the base URL", () => {
		expect(regionEndpoints(selfHosted)).toEqual({
			region: "self-hosted",
			webAppUrl: "https://kimchi.example.com",
			platformApiUrl: "https://kimchi.example.com/api",
			llmBaseUrl: "https://kimchi.example.com/llm",
			openAiBaseUrl: "https://kimchi.example.com/llm/openai/v1",
			anthropicBaseUrl: "https://kimchi.example.com/llm/anthropic",
			experimentalOpenAiBaseUrl: "https://kimchi.example.com/llm/experimental/openai/v1",
			searchUrl: "https://kimchi.example.com/llm/v1/search",
			castApiUrl: "https://kimchi.example.com/api",
			keyValidationUrl: "https://kimchi.example.com/api/v1/llm/openai/supported-providers",
			telemetryLogsUrl: "https://kimchi.example.com/api/ai-optimizer/v1beta/logs:ingest",
			telemetryMetricsUrl: "https://kimchi.example.com/api/ai-optimizer/v1beta/metrics:ingest",
		})
	})

	it("keeps platformApiUrl and castApiUrl on the same /api base by design", () => {
		// Both resolve to base/api: the platform API (/v1/me, /workspaces, ...)
		// and the Cast AI API (/v1/llm/..., /ai-optimizer/...) serve disjoint
		// sub-paths behind the one self-hosted gateway. This is intentional —
		// see the comment on selfHostedRegion.
		expect(platformApiUrl(selfHosted)).toBe(selfHosted.castApiUrl)
	})

	it("strips a trailing slash from the base before appending paths", () => {
		const trailing = selfHostedRegion("https://kimchi.example.com/")
		expect(trailing.llmBaseUrl).toBe("https://kimchi.example.com/llm")
		expect(trailing.castApiUrl).toBe("https://kimchi.example.com/api")
		expect(trailing.webAppUrl).toBe("https://kimchi.example.com")
	})
})

describe("normalizeSelfHostedBaseUrl", () => {
	it("trims whitespace and trailing slashes", () => {
		expect(normalizeSelfHostedBaseUrl("  https://kimchi.example.com  ")).toBe("https://kimchi.example.com")
		expect(normalizeSelfHostedBaseUrl("https://kimchi.example.com/")).toBe("https://kimchi.example.com")
		expect(normalizeSelfHostedBaseUrl("https://kimchi.example.com///")).toBe("https://kimchi.example.com")
	})

	it("accepts http and https, rejects everything else", () => {
		expect(normalizeSelfHostedBaseUrl("http://kimchi.intranet.example")).toBe("http://kimchi.intranet.example")
		expect(normalizeSelfHostedBaseUrl("ftp://kimchi.example.com")).toBeUndefined()
		expect(normalizeSelfHostedBaseUrl("kimchi.example.com")).toBeUndefined()
		expect(normalizeSelfHostedBaseUrl("not a url")).toBeUndefined()
		expect(normalizeSelfHostedBaseUrl("https://")).toBeUndefined()
	})

	it("treats blank input as unset", () => {
		expect(normalizeSelfHostedBaseUrl(undefined)).toBeUndefined()
		expect(normalizeSelfHostedBaseUrl("")).toBeUndefined()
		expect(normalizeSelfHostedBaseUrl("   ")).toBeUndefined()
	})
})

describe("isRegionId", () => {
	it("accepts known region ids", () => {
		expect(isRegionId("us")).toBe(true)
		expect(isRegionId("eu")).toBe(true)
		expect(isRegionId("self-hosted")).toBe(true)
	})

	it("rejects unknown ids and non-strings", () => {
		expect(isRegionId("moon")).toBe(false)
		expect(isRegionId("")).toBe(false)
		expect(isRegionId("US")).toBe(false)
		expect(isRegionId(undefined)).toBe(false)
		expect(isRegionId(null)).toBe(false)
		expect(isRegionId(42)).toBe(false)
	})

	it("rejects Object.prototype keys — only own REGIONS properties count", () => {
		expect(isRegionId("constructor")).toBe(false)
		expect(isRegionId("toString")).toBe(false)
		expect(isRegionId("__proto__")).toBe(false)
		expect(isRegionId("hasOwnProperty")).toBe(false)
	})
})

describe("selectableRegions", () => {
	it("lists every region when experimental features are enabled", async () => {
		await withExperimentalFeatures(true, () => {
			expect(selectableRegions().map((r) => r.id)).toEqual(["us", "eu", "self-hosted"])
		})
	})

	it("lists only the default region when experimental features are off", async () => {
		await withExperimentalFeatures(false, () => {
			expect(selectableRegions()).toEqual([REGIONS.us])
		})
	})

	it("keeps the EU id and endpoints resolvable while gated (stored config keeps working)", async () => {
		await withExperimentalFeatures(false, () => {
			expect(isRegionId("eu")).toBe(true)
			expect(REGIONS.eu.llmBaseUrl).toBe("https://llm.eu.kimchi.dev")
			expect(selectableRegions().some((r) => r.id === "eu")).toBe(false)
		})
	})

	it("gates self-hosted selection like eu while keeping it resolvable when stored", async () => {
		await withExperimentalFeatures(false, () => {
			// Selection-only gate: isRegionId still validates, so a stored
			// region or KIMCHI_REGION=self-hosted keeps resolving endpoints.
			expect(isRegionId("self-hosted")).toBe(true)
			expect(selectableRegions().some((r) => r.id === "self-hosted")).toBe(false)
		})
		await withExperimentalFeatures(true, () => {
			expect(selectableRegions().some((r) => r.id === "self-hosted")).toBe(true)
		})
	})
})
