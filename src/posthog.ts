/**
 * Lightweight PostHog capture via direct HTTP POST.
 *
 * Fire-and-forget: errors are swallowed so analytics failures never affect CLI
 * operation. Callers can optionally await the returned promise at shutdown to
 * reduce the chance of truncated sends.
 */

const POSTHOG_ENDPOINT = "https://eu.i.posthog.com/i/v0/e"

interface PostHogEvent {
	event: string
	distinctId: string
	properties?: Record<string, string | number | boolean>
}

/**
 * Read the PostHog API key at call time, not module-load time.
 * Allows tests to stub the env var before the first call.
 */
function getApiKey(): string {
	return (
		process.env.KIMCHI_POSTHOG_API_KEY ??
		// Injected at build time by the release workflow (see release.yml).
		// Empty string means dev build — events are silently dropped.
		""
	)
}

/**
 * Send a PostHog capture event. Returns a promise that resolves when the HTTP
 * request completes (success or failure). Errors are never thrown.
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
		properties: evt.properties ?? {},
		timestamp: new Date().toISOString(),
	}

	try {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), 5_000)

		await fetch(POSTHOG_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: controller.signal,
		})

		clearTimeout(timeout)
	} catch {
		// Swallow all errors — analytics must never affect CLI operation.
	}
}
