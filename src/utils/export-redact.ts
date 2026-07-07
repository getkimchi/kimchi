/**
 * Deep-recursive secret redaction for session exports.
 *
 * Walks any JS value (objects, arrays, strings) and replaces secrets
 * in-place while preserving surrounding structure. Applied during
 * export post-processing so that `/export` output is always safe.
 *
 * Detection strategies (applied in priority order):
 * 1. Known-key redaction — JSON keys matching sensitive field names
 * 2. Known-token-prefix — values with recognizable API-key prefixes
 * 3. Authorization header — `Authorization: Bearer ...` patterns
 * 4. High-entropy strings — long base64/hex tokens
 * 5. Local auth/config paths — credential file paths
 * 6. Sensitive env var names — known credential env vars
 */

/** Sentinel replacement values for redacted secrets. */
export const REDACTED = {
	key: "[REDACTED:key]",
	token: "[REDACTED:token]",
	authHeader: "[REDACTED:auth-header]",
	highEntropy: "[REDACTED:high-entropy]",
	path: "[REDACTED:path]",
	env: "[REDACTED:env]",
} as const

/** Regex for JSON keys that indicate the value is sensitive. */
const SENSITIVE_KEY_RE =
	/(?:^|[_-])(auth|token|password|passwd|secret|apikey|api_key|credential|private_?key|access_?key|client_?secret|refresh_?token|bearer)(?:$|[_-])/i

/** Known API-key / token prefixes (case-insensitive, anchored for standalone values). */
const TOKEN_PREFIX_RE =
	/^(?:castai_v1_|sk-|pk[-_]|gh[psou]_|github_pat_|xox[bap]-|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{30,})/i

/** Non-anchored version for finding token prefixes within larger text. */
const TOKEN_PREFIX_SUBSTRING_RE =
	/(?:castai_v1_|sk-|pk[-_]|gh[psou]_|github_pat_|xox[bap]-|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{30,})[A-Za-z0-9._~+/=-]*/gi

/** Authorization header pattern — handles JSON, HTTP header, and CLI contexts.
 * Uses lookbehind so the leading delimiter (space, quote, start) is preserved. */
const AUTH_HEADER_RE = /(?<=^|[\s"&'])(authorization["']?\s*[:=]\s*["']?bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi

/** Sensitive env var names. */
const SENSITIVE_ENV_RE =
	/^(KIMCHI_API_KEY|CASTAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)$/i

/** Local auth/config paths that should be excluded from exports. */
const SENSITIVE_PATH_RE =
	/(?:~\/\.config\/kimchi\/config\.json|~\/\.claude\/settings\.json|\.kimchi\/config\.json|\/\.config\/kimchi\/|\/\.claude\/)/i

/** Minimum length for high-entropy string detection. */
const MIN_HIGH_ENTROPY_LEN = 32

/** Character set for high-entropy strings (base64, hex, URL-safe base64). */
const HIGH_ENTROPY_CHARSET_RE = /^[A-Za-z0-9+/_=\-]+$/

/** Shannon entropy threshold (bits per char). */
const ENTROPY_THRESHOLD = 4.0

/** Strings shorter than this are never considered high-entropy tokens. */
const MIN_TOKEN_LEN = 20

/** Fields that are safe and should not be redacted (metadata). */
const SAFE_FIELDS = new Set([
	"type",
	"id",
	"parentId",
	"timestamp",
	"customType",
	"leafId",
	"role",
	"provider",
	"api",
	"model",
	"responseModel",
	"stopReason",
	"traceIds",
	"toolName",
	"toolCallId",
	"name",
	"description",
	"parameters",
])

/**
 * Calculate Shannon entropy of a string (bits per character).
 */
function shannonEntropy(str: string): number {
	if (str.length === 0) return 0
	const freq = new Map<string, number>()
	for (const char of str) {
		freq.set(char, (freq.get(char) ?? 0) + 1)
	}
	let entropy = 0
	const len = str.length
	for (const count of freq.values()) {
		const p = count / len
		entropy -= p * Math.log2(p)
	}
	return entropy
}

/**
 * Check if a string is a high-entropy token (likely a secret).
 * Excludes strings with spaces/newlines (natural language) and
 * known-safe patterns.
 */
function isHighEntropyToken(value: string): boolean {
	if (value.length < MIN_HIGH_ENTROPY_LEN) return false
	if (!HIGH_ENTROPY_CHARSET_RE.test(value)) return false
	// Exclude strings that look like file paths or URLs
	if (/[/.]/.test(value) && value.includes("/")) return false
	// Exclude base64-encoded images (data URIs)
	if (value.startsWith("data:")) return false
	return shannonEntropy(value) >= ENTROPY_THRESHOLD
}

/**
 * Redact a single string value. Returns the redacted string or the
 * original if no secret pattern matched.
 *
 * Priority: env-var-name > token-prefix > local-path > auth-header >
 * high-entropy > sensitive-key. More specific value-based detections
 * take priority over the generic key-based catch-all so we can label
 * the redaction category accurately.
 */
export function redactString(value: string, keyHint?: string): string {
	if (typeof value !== "string" || value.length === 0) return value

	const trimmed = value.trim()

	// Strategy 1: Sensitive env var name (most specific)
	if (keyHint && SENSITIVE_ENV_RE.test(keyHint.trim())) {
		return REDACTED.env
	}

	// Strategy 2: Known-token-prefix (standalone value)
	if (TOKEN_PREFIX_RE.test(trimmed)) {
		return REDACTED.token
	}

	// Strategy 2b: Token-prefix substring within larger text
	// (e.g. "I used key castai_v1_leaked_key in the API call")
	const substringMatches = value.match(TOKEN_PREFIX_SUBSTRING_RE)
	if (substringMatches) {
		let result = value
		for (const match of substringMatches) {
			result = result.replace(match, REDACTED.token)
		}
		if (result !== value) return result
	}

	// Strategy 3: Local auth/config paths
	if (SENSITIVE_PATH_RE.test(value)) {
		return REDACTED.path
	}

	// Strategy 4: Authorization header (within larger text)
	if (AUTH_HEADER_RE.test(value)) {
		AUTH_HEADER_RE.lastIndex = 0
		const result = value.replace(AUTH_HEADER_RE, "$1[REDACTED]")
		AUTH_HEADER_RE.lastIndex = 0
		if (result !== value) return result
	}

	// Strategy 5: High-entropy strings
	// Only check standalone strings, not substrings in natural language
	if (value.length >= MIN_TOKEN_LEN && !value.includes(" ") && !value.includes("\n")) {
		if (isHighEntropyToken(value)) {
			return REDACTED.highEntropy
		}
	}

	// Strategy 6: Sensitive key (catch-all for sensitive keys whose
	// values didn't match a more specific pattern)
	if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) {
		return REDACTED.key
	}

	return value
}

/**
 * Deep-recursive redaction. Walks objects and arrays, replacing secret
 * values in-place while preserving structure.
 *
 * @param value - Any JS value to redact
 * @param keyHint - The parent key name (for key-based detection)
 * @returns The redacted value (same reference for objects/arrays, with
 *          values mutated in-place)
 */
export function redactDeep<T>(value: T, keyHint?: string): T {
	if (typeof value === "string") {
		return redactString(value, keyHint) as unknown as T
	}

	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			value[i] = redactDeep(value[i], keyHint) as unknown as (typeof value)[number]
		}
		return value
	}

	if (value !== null && typeof value === "object") {
		// If the parent key is sensitive and the value is an object/array,
		// replace the entire value rather than recursing into it.
		// This prevents leaking nested structure (e.g. `{ bearer: "token" }`).
		if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) {
			return REDACTED.key as unknown as T
		}
		if (keyHint && SENSITIVE_ENV_RE.test(keyHint.trim())) {
			return REDACTED.env as unknown as T
		}
		const obj = value as Record<string, unknown>
		for (const key of Object.keys(obj)) {
			// Skip safe metadata fields (but still recurse into their values
			// if they're objects/arrays — only skip key-based redaction)
			const hint = SAFE_FIELDS.has(key) ? undefined : key
			obj[key] = redactDeep(obj[key], hint)
		}
		return value
	}

	// Primitives (number, boolean, null, undefined) pass through
	return value
}

/**
 * Redact all session entries in-place. Walks messages, tool calls,
 * tool results, custom entries, and any nested structures.
 */
export function redactEntries<T extends Record<string, unknown>>(entries: T[]): T[] {
	for (const entry of entries) {
		redactDeep(entry)
	}
	return entries
}

/**
 * Redact a complete session export data object (as used by HTML export).
 * Redacts entries, systemPrompt, and tool definitions.
 */
export function redactSessionData<T extends Record<string, unknown>>(data: T): T {
	// Redact entries
	if (Array.isArray(data.entries)) {
		redactEntries(data.entries as Record<string, unknown>[])
	}

	// Redact system prompt
	if (typeof data.systemPrompt === "string") {
		;(data as Record<string, unknown>).systemPrompt = redactString(data.systemPrompt as unknown as string)
	}

	// Redact tools (unlikely to have secrets, but scan for safety)
	if (Array.isArray(data.tools)) {
		redactDeep(data.tools)
	}

	return data
}
