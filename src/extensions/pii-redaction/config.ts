/**
 * Redaction configuration reader.
 *
 * Precedence (highest to lowest):
 *   1. KIMCHI_REDACTION_ENABLED env var — "0" or "false" disables
 *   2. config.json `redaction.enabled` boolean (via loadConfig project/global merge)
 *   3. Default: enabled (true)
 *
 * The config is cached at first call to avoid synchronous disk I/O on every
 * provider request. Env var changes require a restart (same as telemetry config).
 */

import { homedir } from "node:os"
import { resolve } from "node:path"
import { loadConfig } from "../../config.js"

export interface RedactionConfig {
	/** Whether PII/secret redaction is active. */
	enabled: boolean
}

/** Cached redaction config — read once, not on every request. */
let cachedConfig: RedactionConfig | undefined

/**
 * Read the redaction configuration using the same project/global merge as loadConfig.
 *
 * The global config path is computed dynamically (not from the module-level
 * KIMCHI_CONFIG_PATH constant) so test isolation via process.env.HOME works.
 */
function readRedactionConfigFromDisk(): RedactionConfig {
	// 1. Env var takes highest precedence
	const envValue = process.env.KIMCHI_REDACTION_ENABLED
	if (envValue !== undefined && envValue !== "") {
		const enabled = envValue !== "0" && envValue !== "false"
		return { enabled }
	}

	// 2. config.json redaction.enabled (merged via loadConfig — project overrides global)
	// Compute path dynamically so tests can redirect via process.env.HOME.
	const globalConfigPath = resolve(homedir(), ".config", "kimchi", "config.json")
	const config = loadConfig({ configPath: globalConfigPath })
	if (config.redaction && typeof config.redaction.enabled === "boolean") {
		return { enabled: config.redaction.enabled }
	}

	// 3. Default: enabled
	return { enabled: true }
}

/**
 * Get the redaction configuration (cached after first call).
 *
 * The cache avoids synchronous I/O in the hot `before_provider_request` path.
 */
export function getRedactionConfig(): RedactionConfig {
	if (!cachedConfig) {
		cachedConfig = readRedactionConfigFromDisk()
	}
	return cachedConfig
}

/** Reset the cached config — for test isolation. */
export function resetRedactionConfigCache(): void {
	cachedConfig = undefined
}
