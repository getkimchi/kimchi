/**
 * Pre-session telemetry for CLI-level events that fire before the agent
 * session (and its SessionContext) are created.
 *
 * Uses the existing OTEL transport from `transport.ts` so payloads are
 * identical to in-session events (same resource attributes, same log-record
 * structure, same `client` attribute placement).
 *
 * Events: app_started, harness_launched, setup_aborted, setup_completed,
 * tools_setup_aborted, tool_configured, tools_setup_completed.
 *
 * Fire-and-forget: errors are swallowed. Callers should call `drain()` before
 * `process.exit()` to reduce the chance of truncated HTTP requests.
 */

import { arch, platform } from "node:os"
import { getMe } from "../../api/me.js"
import type { TelemetryConfig } from "../../config.js"
import { ensureDeviceId } from "../../posthog-device.js"
import { getVersion } from "../../utils.js"
import { sendLog } from "./transport.js"

// ---------------------------------------------------------------------------
// Arch mapping (Node → Go-compatible names for historical compatibility)
// ---------------------------------------------------------------------------

function goArch(): string {
	const a = arch()
	switch (a) {
		case "x64":
			return "amd64"
		case "ia32":
			return "386"
		default:
			return a
	}
}

// ---------------------------------------------------------------------------
// User identity cache — fetched once per process via /v1/me
// ---------------------------------------------------------------------------

let userFetched = false
let cachedUserEmail: string | undefined
let cachedUserId: string | undefined
let userFetchPromise: Promise<void> | undefined

/** @internal — exposed for testing only */
export function _resetUserCache(): void {
	userFetched = false
	cachedUserEmail = undefined
	cachedUserId = undefined
	userFetchPromise = undefined
}

function ensureUserIdentity(apiKey: string): Promise<void> {
	if (userFetched) return Promise.resolve()
	if (userFetchPromise) return userFetchPromise

	userFetchPromise = getMe(apiKey, { signal: AbortSignal.timeout(3000) })
		.then((me) => {
			cachedUserEmail = me.email
			cachedUserId = me.id
		})
		.catch(() => {
			// best effort — telemetry continues without email/id
		})
		.finally(() => {
			userFetched = true
			userFetchPromise = undefined
		})

	return userFetchPromise
}

// ---------------------------------------------------------------------------
// In-flight tracking for drain
// ---------------------------------------------------------------------------

const pending: Promise<void>[] = []

function track(p: Promise<void>): void {
	pending.push(p)
	p.finally(() => {
		const idx = pending.indexOf(p)
		if (idx >= 0) pending.splice(idx, 1)
	})
}

/**
 * Wait for all in-flight pre-session telemetry sends to settle.
 * Call before `process.exit()` to reduce truncated requests.
 * Times out after 3 seconds to avoid blocking shutdown indefinitely.
 */
export async function drain(): Promise<void> {
	if (pending.length === 0) return
	await Promise.race([Promise.allSettled([...pending]), new Promise<void>((resolve) => setTimeout(resolve, 3_000))])
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a pre-session telemetry event through the standard OTEL transport.
 *
 * The returned promise resolves when the HTTP request completes (or fails).
 * Errors are never thrown. The promise is tracked internally so `drain()`
 * can await it before process exit.
 */
export function sendPreSessionEvent(
	config: TelemetryConfig,
	event: string,
	properties?: Record<string, string | number>,
): void {
	const hasAuth = Object.keys(config.headers).some((k) => k.toLowerCase() === "authorization")
	if (!config.enabled || !hasAuth) return

	const p = doSend(config, event, properties)
	track(p)
}

async function doSend(
	config: TelemetryConfig,
	event: string,
	properties?: Record<string, string | number>,
): Promise<void> {
	try {
		await ensureUserIdentity(config.apiKey)

		const deviceId = ensureDeviceId()
		const attrs: Record<string, string | number> = {
			"telemetry.cli_version": getVersion(),
			"telemetry.os": platform(),
			"telemetry.arch": goArch(),
		}

		if (cachedUserId) {
			attrs["user.account_uuid"] = cachedUserId
		}

		if (properties) {
			for (const [key, value] of Object.entries(properties)) {
				attrs[`event.${key}`] = value
			}
		}

		await sendLog(config, deviceId || "unknown", event, attrs, cachedUserEmail)
	} catch {
		// Swallow all errors — telemetry must never affect CLI operation.
	}
}
