/**
 * Region registry: single source of truth for the supported regions and every
 * external endpoint the CLI talks to.
 *
 * Import-light by design (only the dependency-free experimental-flag module)
 * so config, cli-auth, and login flows can all import it without import cycles.
 */

import { isExperimentalFeaturesEnabled } from "./extensions/experimental.js"

interface RegionDefinition {
	id: string
	label: string
	/** Base URL of the Kimchi web app (login pages, billing links, platform API). */
	webAppUrl: string
	/** Base URL of the LLM gateway (chat/completions, router, search). */
	llmBaseUrl: string
	/** Base URL of the Cast AI API (key validation, telemetry, stats). */
	castApiUrl: string
}

/** Supported regions; the keys define RegionId. */
export const REGIONS = {
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
	// Self-hosted has no fixed URLs: the user provides ONE base URL and every
	// endpoint derives from it via `selfHostedRegion(base)` (see below). The
	// placeholder keeps the key present so `RegionId` includes "self-hosted"
	// and a stored region / KIMCHI_REGION value validates; endpoint resolution
	// refuses self-hosted without a configured base URL (see endpointsForRegion
	// in src/config.ts) rather than resolving these empty placeholders.
	"self-hosted": {
		id: "self-hosted",
		label: "Self-hosted",
		webAppUrl: "",
		llmBaseUrl: "",
		castApiUrl: "",
	},
} as const satisfies Record<string, RegionDefinition>

export type RegionId = keyof typeof REGIONS

export interface KimchiRegion extends RegionDefinition {
	id: RegionId
}

export const DEFAULT_REGION: RegionId = "us"

/**
 * Env override for the region, for headless/CI setups that cannot run the
 * interactive login selector (e.g. `KIMCHI_REGION=eu` next to
 * `KIMCHI_API_KEY`). Unknown values are treated as unset, same as the config
 * file parse. Region is otherwise chosen at login, not set via `kimchi
 * config`.
 */
export const REGION_ENV = "KIMCHI_REGION"

/**
 * Env override for the self-hosted base URL, the headless/CI companion to
 * `KIMCHI_REGION=self-hosted`. Invalid values warn once and count as unset
 * (see src/config.ts), falling back to the stored `selfHostedUrl`.
 */
export const SELF_HOSTED_URL_ENV = "KIMCHI_SELF_HOSTED_URL"

export function isRegionId(value: unknown): value is RegionId {
	// Object.hasOwn, not `in`: "constructor"/"__proto__" are on the prototype chain.
	return typeof value === "string" && Object.hasOwn(REGIONS, value)
}

/**
 * Regions offered in pickers and advertised to clients. `eu` and `self-hosted`
 * are gated behind --enable-experimental-features until generally available.
 *
 * This gate is SELECTION-ONLY by design: `REGIONS`, `isRegionId`, and
 * `endpointsForRegion` always resolve them, so a stored `region: "eu"` (or
 * `"self-hosted"`) config or `KIMCHI_REGION=eu` keeps working when the flag
 * is off. Evaluated per call (not at module load) because cli.ts sets the flag
 * after imports evaluate.
 *
 * To release a region: make this return Object.values(REGIONS) unconditionally
 * (single-file change; no call sites to revert).
 */
export function selectableRegions(): KimchiRegion[] {
	const regions = Object.values(REGIONS)
	if (isExperimentalFeaturesEnabled()) return regions
	return regions.filter((region) => region.id === DEFAULT_REGION)
}

/**
 * Build the self-hosted region from the user-provided base URL.
 *
 * Derivation contract — ONE base URL drives every endpoint:
 *   webAppUrl  = base           (login pages, /cli-auth, billing links)
 *   llmBaseUrl = base + "/llm"  (chat, anthropic, search, models, credits)
 *   castApiUrl = base + "/api"  (key validation, telemetry, stats)
 *
 * NOTE: `castApiUrl` and `platformApiUrl` (webAppUrl + "/api") intentionally
 * BOTH resolve to `base/api`. The platform API (/v1/me, /workspaces, ...) and
 * the Cast AI API (/v1/llm/..., /ai-optimizer/...) serve disjoint sub-paths
 * behind the same self-hosted gateway — do not "deduplicate" them.
 *
 * The base is expected pre-normalized (see normalizeSelfHostedBaseUrl); a
 * trailing slash is stripped defensively so `/llm` never becomes `//llm`.
 */
export function selfHostedRegion(base: string): KimchiRegion {
	const trimmed = base.trim().replace(/\/+$/, "")
	return {
		id: "self-hosted",
		label: "Self-hosted",
		webAppUrl: trimmed,
		llmBaseUrl: `${trimmed}/llm`,
		castApiUrl: `${trimmed}/api`,
	}
}

/**
 * Normalize a user-provided self-hosted base URL: trim whitespace and
 * trailing slashes, then require an absolute http(s) URL. Returns undefined
 * for blank or invalid input — callers decide whether to warn, re-prompt, or
 * fail fast.
 */
export function normalizeSelfHostedBaseUrl(raw: string | undefined): string | undefined {
	const value = raw?.trim()
	if (!value) return undefined
	const trimmed = value.replace(/\/+$/, "")
	try {
		if (!/^https?:$/.test(new URL(trimmed).protocol)) return undefined
	} catch {
		return undefined
	}
	return trimmed
}

/**
 * Low-level region → URL derivations.
 *
 * These are building blocks for `endpointsForRegion`/`resolveEndpoints` in
 * src/config.ts, which layer the env overrides on top (KIMCHI_BASE_URL →
 * every llmBaseUrl-derived endpoint, KIMCHI_WEB_APP_URL, KIMCHI_REMOTE_ENDPOINT).
 * Production code must resolve endpoints through those — importing these
 * helpers directly bypasses the overrides. Only use them directly for URLs
 * that are genuinely region-fixed regardless of any env override (e.g.
 * telemetry ingest URLs in src/integrations/constants.ts).
 */
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

/** Every endpoint derived from a region.
 *
 * Building block for `endpointsForRegion`/`resolveEndpoints` in src/config.ts —
 * see the note above `platformApiUrl`. Production code should consume the
 * env-aware wrappers, not this function.
 */
export interface RegionEndpoints {
	region: RegionId
	webAppUrl: string
	platformApiUrl: string
	llmBaseUrl: string
	openAiBaseUrl: string
	anthropicBaseUrl: string
	experimentalOpenAiBaseUrl: string
	searchUrl: string
	castApiUrl: string
	keyValidationUrl: string
	telemetryLogsUrl: string
	telemetryMetricsUrl: string
}

export function regionEndpoints(r: KimchiRegion): RegionEndpoints {
	return {
		region: r.id,
		webAppUrl: r.webAppUrl,
		platformApiUrl: platformApiUrl(r),
		llmBaseUrl: r.llmBaseUrl,
		openAiBaseUrl: openAiBaseUrl(r),
		anthropicBaseUrl: anthropicBaseUrl(r),
		experimentalOpenAiBaseUrl: experimentalOpenAiBaseUrl(r),
		searchUrl: searchUrl(r),
		castApiUrl: r.castApiUrl,
		keyValidationUrl: keyValidationUrl(r),
		telemetryLogsUrl: telemetryLogsUrl(r),
		telemetryMetricsUrl: telemetryMetricsUrl(r),
	}
}
