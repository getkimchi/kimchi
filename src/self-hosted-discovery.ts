/**
 * Self-hosted endpoint discovery.
 *
 * A standalone Kimchi install (castai/kimchi-standalone) serves an
 * unauthenticated discovery document from the console:
 *
 *   GET <console-url>/env/endpoints.json
 *   { "api": "https://kimchi.example.com",
 *     "console": "https://kimchi.example.com",
 *     "llm": "https://llm.example.com" }
 *
 * Each value is an ORIGIN ONLY — no path suffix. Consumers append the API
 * shape they speak (see discoveredSelfHostedRegion in src/regions.ts): the
 * OpenAI-compatible base is <llm>/openai/v1, Anthropic <llm>/anthropic,
 * search <llm>/v1/search.
 *
 * Older installs predate the document (or serve it missing keys): callers
 * fall back to the manual single-base-URL flow with a clear message — this
 * module never throws for such cases, it reports status: "unavailable" with
 * a reason.
 *
 * Import-light by design (regions.ts only) so config, the login flows, and
 * the CLI can all import it without cycles.
 */

import { normalizeSelfHostedEndpoints, type SelfHostedEndpoints } from "./regions.js"

/** Path of the discovery document under the console URL. */
export const SELF_HOSTED_DISCOVERY_PATH = "/env/endpoints.json"

/** Upper bound for the discovery fetch — it gates an interactive login. */
const DISCOVERY_TIMEOUT_MS = 10_000

export type SelfHostedDiscoveryResult =
	| { status: "discovered"; endpoints: SelfHostedEndpoints }
	| { status: "unavailable"; cause: "not-found" | "incomplete" | "fetch-failed"; reason: string }

/** The URL the discovery document is fetched from (trailing slashes on the
 *  console URL are tolerated — see the tests). */
export function selfHostedDiscoveryUrl(consoleUrl: string): string {
	return `${consoleUrl.trim().replace(/\/+$/, "")}${SELF_HOSTED_DISCOVERY_PATH}`
}

/**
 * Parse and validate a discovery document body. All three keys (api, console,
 * llm) must be present and valid http(s) origins; any missing or invalid key
 * makes the document incomplete (undefined) so callers fall back to manual
 * entry. Extra keys are ignored (forward compatibility).
 */
export function parseEndpointsDocument(body: unknown): SelfHostedEndpoints | undefined {
	return normalizeSelfHostedEndpoints(body)
}

/** Minimal fetch Response surface this module consumes (test seam friendly). */
interface ResponseLike {
	ok: boolean
	status: number
	json(): Promise<unknown>
}

export interface FetchSelfHostedEndpointsOptions {
	/** Injected for tests; defaults to global fetch. */
	fetchImpl?: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<ResponseLike>
	/** Fetch timeout. Defaults to 10s. */
	timeoutMs?: number
}

/**
 * Human phrasing for a discovery failure — the console URL the user entered
 * must serve the discovery document; without it there is no self-hosted login
 * (no endpoint can be guessed). Shared by the interactive login flows and the
 * `kimchi login <console-url>` CLI so both surfaces phrase it identically.
 */
export function discoveryFailureMessage(result: Extract<SelfHostedDiscoveryResult, { status: "unavailable" }>): string {
	return `Endpoint discovery failed: ${result.reason}. A self-hosted install must serve ${SELF_HOSTED_DISCOVERY_PATH}.`
}

/**
 * Fetch and validate the discovery document for a console URL. Never throws:
 * every failure mode (network error, timeout, non-200, invalid JSON,
 * incomplete document) resolves as `{ status: "unavailable", reason }` so
 * callers can surface one clear message and fall back to manual entry.
 */
export async function fetchSelfHostedEndpoints(
	consoleUrl: string,
	options: FetchSelfHostedEndpointsOptions = {},
): Promise<SelfHostedDiscoveryResult> {
	const url = selfHostedDiscoveryUrl(consoleUrl)
	const doFetch = options.fetchImpl ?? fetch
	try {
		const response = await doFetch(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS),
		})
		if (response.status === 404) {
			return {
				status: "unavailable",
				cause: "not-found",
				reason: `no discovery document at ${SELF_HOSTED_DISCOVERY_PATH} (HTTP 404)`,
			}
		}
		if (!response.ok) {
			return { status: "unavailable", cause: "fetch-failed", reason: `HTTP ${response.status} from ${url}` }
		}
		let body: unknown
		try {
			body = await response.json()
		} catch {
			// Older installs serve their SPA page for unknown paths (the console
			// route's / prefix catch-all), so /env/endpoints.json can return 200
			// with HTML — treat that as an incomplete document, not a fetch error.
			return {
				status: "unavailable",
				cause: "incomplete",
				reason: `the document at ${SELF_HOSTED_DISCOVERY_PATH} did not return valid JSON (the install likely predates discovery)`,
			}
		}
		const endpoints = parseEndpointsDocument(body)
		if (!endpoints) {
			return {
				status: "unavailable",
				cause: "incomplete",
				reason: `the discovery document at ${SELF_HOSTED_DISCOVERY_PATH} is missing one of the api, console, or llm keys, or has an invalid value`,
			}
		}
		return { status: "discovered", endpoints }
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") {
			return { status: "unavailable", cause: "fetch-failed", reason: `fetching ${url} timed out` }
		}
		const detail = error instanceof Error ? error.message : String(error)
		return { status: "unavailable", cause: "fetch-failed", reason: `fetching ${url} failed (${detail})` }
	}
}
