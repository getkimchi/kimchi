// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { REGIONS, telemetryLogsUrl, telemetryMetricsUrl } from "../regions.js"

/** Identifiers shared by every tool integration. */
export const PROVIDER_NAME = "kimchi"
export const API_KEY_ENV = "KIMCHI_API_KEY"

/** Telemetry ingest URLs of every region, to recognise ones Kimchi wrote earlier.
 * Self-hosted telemetry URLs derive from the user's base URL, so they cannot
 * be enumerated here — the placeholder entry's empty URLs are skipped. */
export const ALL_TELEMETRY_URLS: ReadonlySet<string> = new Set(
	Object.values(REGIONS)
		.filter((r) => r.castApiUrl)
		.flatMap((r) => [telemetryLogsUrl(r), telemetryMetricsUrl(r)]),
)

export const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org"
export const OPENCODE_PLUGIN_PACKAGE = "@kimchi-dev/opencode-kimchi"
export const OPENCODE_PLUGIN_ARRAY_MIN_VERSION = "1.14.0"
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker

export const DUMB_TEST_MARKER_LLM_4329 = "llm-4329-dumb-test-marker"
