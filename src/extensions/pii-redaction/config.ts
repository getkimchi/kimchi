/**
 * Redaction configuration reader.
 *
 * Precedence (highest to lowest):
 *   1. KIMCHI_REDACTION_ENABLED env var — "0" or "false" disables
 *   2. config.json `redaction.enabled` boolean
 *   3. Default: enabled (true)
 *
 * This mirrors the pattern established by readTelemetryConfig in
 * src/config.ts for env/config precedence.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

const KIMCHI_CONFIG_PATH = resolve(homedir(), ".config", "kimchi", "config.json")

export interface RedactionConfig {
	/** Whether PII/secret redaction is active. */
	enabled: boolean
}

/**
 * Read the redaction configuration.
 *
 * @param configPath  Path to config.json (defaults to global ~/.config/kimchi/config.json)
 * @returns           { enabled: boolean } — true unless explicitly disabled
 */
export function readRedactionConfig(configPath: string = KIMCHI_CONFIG_PATH): RedactionConfig {
	// 1. Env var takes highest precedence
	const envValue = process.env.KIMCHI_REDACTION_ENABLED
	if (envValue !== undefined && envValue !== "") {
		const enabled = envValue !== "0" && envValue !== "false"
		return { enabled }
	}

	// 2. config.json redaction.enabled
	try {
		const raw = readFileSync(configPath, "utf-8")
		const parsed = JSON.parse(raw)
		const redaction = parsed.redaction
		if (redaction && typeof redaction === "object" && typeof redaction.enabled === "boolean") {
			return { enabled: redaction.enabled }
		}
	} catch {
		// missing or invalid config — fall through to default
	}

	// 3. Default: enabled
	return { enabled: true }
}
