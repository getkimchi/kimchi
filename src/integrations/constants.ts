import { REGIONS, telemetryLogsUrl, telemetryMetricsUrl } from "../regions.js"

/** Identifiers shared by every tool integration. */
export const PROVIDER_NAME = "kimchi"
export const API_KEY_ENV = "KIMCHI_API_KEY"

/** Telemetry ingest URLs of every region, to recognise ones Kimchi wrote earlier. */
export const ALL_TELEMETRY_URLS: ReadonlySet<string> = new Set(
	Object.values(REGIONS).flatMap((r) => [telemetryLogsUrl(r), telemetryMetricsUrl(r)]),
)

export const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org"
export const OPENCODE_PLUGIN_PACKAGE = "@kimchi-dev/opencode-kimchi"
export const OPENCODE_PLUGIN_ARRAY_MIN_VERSION = "1.14.0"
