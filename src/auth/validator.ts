import { fetchWithRetry } from "../utils/http.js"

export interface ValidateResult {
	valid: boolean
	error?: string
	suggestions?: string[]
}

export const VALIDATION_ENDPOINT = "https://api.cast.ai/v1/llm/openai/supported-providers"
export const REQUEST_TIMEOUT_MS = 10_000

interface ValidatorOptions {
	endpoint?: string
	timeoutMs?: number
	fetch?: typeof globalThis.fetch
}

/**
 * Probe the Cast AI / Kimchi API with the given key. 200 = valid, 401 =
 * bad key, 403 = scope problem, other status = transient. Returns a
 * ValidateResult with user-actionable suggestions instead of throwing —
 * the caller usually wants to re-prompt or log, not crash.
 *
 * Network failures (DNS, timeout, connection refused) come back as
 * `valid: false` with a "Network error" message rather than throwing.
 * The caller can distinguish from a permission failure by inspecting
 * the message.
 */
export async function validateApiKey(apiKey: string, options: ValidatorOptions = {}): Promise<ValidateResult> {
	if (apiKey === "") {
		return {
			valid: false,
			error: "API key is required",
			suggestions: [
				"Get your API key at https://app.kimchi.dev",
				"Set it via KIMCHI_API_KEY environment variable or run 'kimchi setup'",
			],
		}
	}

	const endpoint = options.endpoint ?? VALIDATION_ENDPOINT
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
	const fetchImpl = options.fetch ?? globalThis.fetch

	let resp: Response
	try {
		resp = await fetchWithRetry(
			endpoint,
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
				},
			},
			{ timeoutMs, fetchImpl, retry: { maxRetries: 1 } },
		)
	} catch {
		return {
			valid: false,
			error: "Network error: unable to reach Kimchi API",
			suggestions: [
				"Check your internet connection",
				"Verify you can reach https://api.cast.ai",
				"Try again in a few moments",
			],
		}
	}

	if (resp.status === 200) {
		return { valid: true }
	}
	if (resp.status === 401) {
		return {
			valid: false,
			error: "Invalid API key",
			suggestions: [
				"Verify your API key at https://app.kimchi.dev",
				"Ensure the key has not been revoked",
				"Check for typos or extra whitespace",
			],
		}
	}
	if (resp.status === 403) {
		return {
			valid: false,
			error: "API key lacks required permissions",
			suggestions: [
				"Verify your API key has the required scopes at https://app.kimchi.dev",
				"Contact support if the issue persists",
			],
		}
	}
	return {
		valid: false,
		error: `API returned status ${resp.status}`,
		suggestions: [
			"Try again in a few moments",
			"Check status.cast.ai for service status",
			"Contact support if the issue persists",
		],
	}
}
