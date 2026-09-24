/**
 * Region registry: single source of truth for every external endpoint the CLI
 * talks to, derived from a region id ("us" | "eu").
 *
 * Dependency-free by design (no imports from config.ts) so config, cli-auth,
 * and login flows can all import it without import cycles.
 */

export type RegionId = "us" | "eu"

export interface KimchiRegion {
	id: RegionId
	label: string
	/** Base URL of the Kimchi web app (login pages, billing links, platform API). */
	webAppUrl: string
	/** Base URL of the LLM gateway (chat/completions, router, search). */
	llmBaseUrl: string
	/** Base URL of the Cast AI API (key validation, telemetry, stats). */
	castApiUrl: string
}

export const REGIONS: Record<RegionId, KimchiRegion> = {
	us: {
		id: "us",
		label: "United States",
		webAppUrl: "https://app.kimchi.dev",
		llmBaseUrl: "https://llm.kimchi.dev",
		castApiUrl: "https://api.cast.ai",
	},
	eu: {
		id: "eu",
		label: "Europe",
		webAppUrl: "https://app.eu.kimchi.dev",
		llmBaseUrl: "https://llm.eu.kimchi.dev",
		castApiUrl: "https://api.eu.cast.ai",
	},
}

export const DEFAULT_REGION: RegionId = "us"

export function isRegionId(value: unknown): value is RegionId {
	// Object.hasOwn, not `value in REGIONS`: the `in` operator walks the
	// prototype chain, so "constructor"/"toString"/"__proto__" would pass and
	// getRegion would return Object.prototype members instead of a KimchiRegion.
	return typeof value === "string" && Object.hasOwn(REGIONS, value)
}

export function getRegion(id: unknown): KimchiRegion {
	return isRegionId(id) ? REGIONS[id] : REGIONS[DEFAULT_REGION]
}

/** Platform API base (`/v1/me`, teleport, agents, sandbox). */
export function platformApiUrl(r: KimchiRegion): string {
	return `${r.webAppUrl}/api`
}

/** Main chat/completions base. */
export function openAiBaseUrl(r: KimchiRegion): string {
	return `${r.llmBaseUrl}/openai/v1`
}

/** Anthropic-compatible base. */
export function anthropicBaseUrl(r: KimchiRegion): string {
	return `${r.llmBaseUrl}/anthropic`
}

/** Experimental model provider base. */
export function experimentalOpenAiBaseUrl(r: KimchiRegion): string {
	return `${r.llmBaseUrl}/experimental/openai/v1`
}

/** Web-search tool endpoint. */
export function searchUrl(r: KimchiRegion): string {
	return `${r.llmBaseUrl}/v1/search`
}

/** API-key validation endpoint. */
export function keyValidationUrl(r: KimchiRegion): string {
	return `${r.castApiUrl}/v1/llm/openai/supported-providers`
}

export function telemetryLogsUrl(r: KimchiRegion): string {
	return `${r.castApiUrl}/ai-optimizer/v1beta/logs:ingest`
}

export function telemetryMetricsUrl(r: KimchiRegion): string {
	return `${r.castApiUrl}/ai-optimizer/v1beta/metrics:ingest`
}

/** Cast AI stats API base (analytics, productivity metrics). */
export function statsApiBaseUrl(r: KimchiRegion): string {
	return r.castApiUrl
}
