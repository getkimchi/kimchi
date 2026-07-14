import type { KimchiConfig } from "../config.js"
import { buildConfigSnapshot, type ConfigSnapshot } from "../extensions/telemetry/config-snapshot.js"
import { getOsMetadata, type OsMetadata } from "./os-metadata.js"

/**
 * The launch-time metadata captured once per process at session start.
 *
 * Combines the host/OS telemetry keys with a config snapshot of the harness
 * configuration as it was at launch. Frozen on capture so downstream exporters
 * (JSONL/HTML session writers) receive a stable reference they cannot mutate.
 * `capturedAt` is the epoch-millisecond time the capture was taken.
 */
export interface SessionStartMetadata {
	os: OsMetadata
	config: ConfigSnapshot
	capturedAt: number
}

/**
 * A single in-session configuration change buffered between capture and
 * export-time injection into the session exports.
 */
export interface ConfigChangeRecord {
	key: string
	value: string | number | boolean
	timestamp: number
}

// ---------------------------------------------------------------------------
// Module-level singleton store — one instance per process, shared across all
// importers. `let` (not `const`) so the internal reset helper can rebind.
// ---------------------------------------------------------------------------

let sessionStart: SessionStartMetadata | undefined
let configChanges: ConfigChangeRecord[] = []

/**
 * Capture launch-time metadata: host/OS info + a config snapshot of the
 * harness configuration.
 *
 * Stores them together as a single frozen object and overwrites any prior
 * capture. Wrapped in try/catch so a failure in either helper can never crash
 * the CLI; on failure the store is left empty (prior capture, if any, is not
 * disturbed).
 */
export function captureSessionStart(config: KimchiConfig, telemetryEnabled: boolean): void {
	try {
		const captured: SessionStartMetadata = {
			os: getOsMetadata(),
			config: buildConfigSnapshot(config, telemetryEnabled),
			capturedAt: Date.now(),
		}
		sessionStart = Object.freeze(captured)
	} catch {
		// Never let metadata capture crash the CLI — leave the store as-is.
	}
}

/**
 * Buffer an in-session configuration change for export-time injection.
 *
 * Entries are appended in the order they arrive. Never throws — a failure
 * leaves the buffer unchanged.
 */
export function recordConfigChange(key: string, value: string | number | boolean, timestamp?: number): void {
	try {
		configChanges.push({ key, value, timestamp: timestamp ?? Date.now() })
	} catch {
		// Never let a change record crash the CLI.
	}
}

/**
 * Returns the frozen launch-time capture, or `undefined` if it was never
 * captured (or capture failed).
 */
export function getSessionStartMetadata(): SessionStartMetadata | undefined {
	return sessionStart
}

/**
 * Returns a readonly view of the buffered config changes. Returns an empty
 * array when none have been recorded.
 */
export function getConfigChanges(): ReadonlyArray<ConfigChangeRecord> {
	return configChanges
}

/**
 * @internal Test helper — clears the captured metadata and the change buffer
 * so each test starts from a pristine process-scoped store.
 */
export function _resetSessionMetadataStore(): void {
	sessionStart = undefined
	configChanges = []
}
