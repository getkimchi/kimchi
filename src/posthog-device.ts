/**
 * Shared device-ID resolution for PostHog analytics.
 *
 * The device ID is a UUID generated on first-run and persisted in
 * ~/.config/kimchi/config.json. It serves as PostHog's distinct_id so
 * unique installs can be counted. Reads the legacy snake_case `device_id`
 * field for backwards compatibility.
 */

import { randomUUID } from "node:crypto"
import { loadConfig, readTelemetryConfig, writeDeviceId } from "./config.js"

/**
 * Return the persisted device ID, generating and saving one if it doesn't
 * exist yet. Only generates a new ID when telemetry is enabled — opted-out
 * users do not get a device ID persisted.
 *
 * Returns an empty string when telemetry is disabled and no device ID was
 * previously persisted.
 */
export function ensureDeviceId(): string {
	const config = loadConfig()
	if (config.deviceId) return config.deviceId

	const telemetry = readTelemetryConfig()
	if (!telemetry.enabled) return ""

	const id = randomUUID()
	writeDeviceId(id)
	return id
}
