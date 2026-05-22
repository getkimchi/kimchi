/**
 * Lightweight PostHog capture via direct HTTP POST.
 *
 * Fire-and-forget: errors are swallowed so analytics failures never affect CLI
 * operation. Callers can optionally await the returned promise at shutdown to
 * reduce the chance of truncated sends.
 *
 * Uses a device-ID–based distinct_id, default properties attached to every
 * event, and per-event property overrides.
 */

import { arch, platform } from "node:os"
import { KIMCHI_POSTHOG_API_KEY } from "./generated/posthog-key.generated.js"
import { getVersion } from "./utils.js"

/**
 * Map Node.js arch() values to Go's runtime.GOARCH equivalents so PostHog
 * dashboards built against historical data remain compatible.
 */
function goArch(): string {
	const a = arch()
	switch (a) {
		case "x64":
			return "amd64"
		case "ia32":
			return "386"
		default:
			return a // arm64, arm, etc. already match
	}
}

const POSTHOG_ENDPOINT = "https://eu.i.posthog.com/i/v0/e"

interface PostHogEvent {
	event: string
	distinctId: string
	properties?: Record<string, string | number | boolean>
}

/**
 * Read the PostHog API key.
 *
 * In release builds, `scripts/build-binary.js` generates
 * `src/generated/posthog-key.generated.ts` with the real key before compiling,
 * so the key is baked into the binary and available without any runtime env var.
 *
 * In dev/test builds the generated file contains an empty string, so it falls
 * through to `process.env.KIMCHI_POSTHOG_API_KEY` — tests can stub it, and dev
 * runs are no-ops (empty string → events silently dropped).
 */
function getApiKey(): string {
	return KIMCHI_POSTHOG_API_KEY || process.env.KIMCHI_POSTHOG_API_KEY || ""
}

/**
 * Default properties attached to every PostHog event.
 * Default properties attached to every PostHog event: cli_version, os, arch.
 */
function defaultProperties(): Record<string, string> {
	return {
		cli_version: getVersion(),
		os: platform(),
		arch: goArch(),
	}
}

/**
 * Send a PostHog capture event. Returns a promise that resolves when the HTTP
 * request completes (success or failure). Errors are never thrown.
 *
 * Default properties (cli_version, os, arch) are merged into every event —
 * per-event properties override defaults if keys collide.
 *
 * If KIMCHI_POSTHOG_API_KEY is unset/empty (dev builds), this is a no-op.
 */
export async function capturePostHogEvent(evt: PostHogEvent): Promise<void> {
	const apiKey = getApiKey()
	if (!apiKey) return

	const payload = {
		api_key: apiKey,
		event: evt.event,
		distinct_id: evt.distinctId,
		properties: { ...defaultProperties(), ...evt.properties },
		timestamp: new Date().toISOString(),
	}

	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 5_000)
	try {
		await fetch(POSTHOG_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: controller.signal,
		})
	} catch {
		// Swallow all errors — analytics must never affect CLI operation.
	} finally {
		clearTimeout(timeout)
	}
}
