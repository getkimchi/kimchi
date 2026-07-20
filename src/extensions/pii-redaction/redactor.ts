/**
 * PII redactor built on @bulkhead-ai/core.
 *
 * Scans text content in pi-ai messages for PII (emails, phones, SSNs, credit
 * cards via Luhn, IBANs via mod-97) and secrets (API keys, Bearer tokens, AWS
 * keys, GitHub tokens) using regex-based guards. Matches are replaced with
 * `[REDACTED-TYPE]` markers (e.g. `[REDACTED-EMAIL_ADDRESS]`,
 * `[REDACTED-CREDIT_CARD]`, `[REDACTED-GITHUB_TOKEN]`).
 *
 * Additional custom patterns (castai_v1_ keys, Bearer/OAuth tokens, sensitive
 * JSON fields) are applied as a second pass because the bulkhead engine does
 * not cover them.
 *
 * The engine is lazily initialized — `createEngine()` instantiates guard
 * objects with compiled regex patterns, which is cheap. The cached instance is
 * stateless (no per-session data) so it does not leak across sessions or tests.
 * `resetRedactorEngine()` is exported for test isolation.
 */

import { type BulkheadConfig, createEngine, DEFAULT_CONFIG, type GuardrailsEngine } from "@bulkhead-ai/core"

let engine: GuardrailsEngine | undefined

/**
 * Get or create the singleton redaction engine.
 *
 * PiiGuard covers emails, phones, SSNs, credit cards (Luhn), IBANs (mod-97).
 * SecretGuard covers API keys, Bearer tokens, AWS keys, GitHub tokens.
 * Injection and content-safety guards are disabled — not relevant to PII
 * scrubbing.
 */
function getEngine(): GuardrailsEngine {
	if (engine) return engine
	const config: BulkheadConfig = {
		...DEFAULT_CONFIG,
		enabled: true,
		guards: {
			pii: { enabled: true },
			secret: { enabled: true },
			injection: { enabled: false },
			contentSafety: { enabled: false },
		},
	}
	engine = createEngine(config)
	// Exclude GUIDs from redaction — they are structural identifiers
	// (ferment IDs, session IDs), not sensitive PII. Redacting them breaks
	// internal flows that depend on UUIDs being present in context.
	engine.setExcludeEntities(["GUID"])
	return engine
}

/** Reset the cached engine — for test isolation. */
export function resetRedactorEngine(): void {
	engine = undefined
}

// ---------------------------------------------------------------------------
// Custom redaction patterns not covered by @bulkhead-ai/core
// ---------------------------------------------------------------------------

interface CustomPattern {
	name: string
	regex: RegExp
}

const CUSTOM_PATTERNS: CustomPattern[] = [
	// CastAI API keys
	{ name: "CASTAI_API_KEY", regex: /castai_v1_[A-Za-z0-9_-]{8,}/g },
	// Bearer tokens (Authorization header or standalone)
	// biome-ignore lint/complexity/noUselessEscapeInRegex: -
	{ name: "BEARER_TOKEN", regex: /(?:Bearer\s+)([A-Za-z0-9_\-\.]{16,})/gi },
	// OAuth tokens (Google ya29.*, Azure)
	// biome-ignore lint/complexity/noUselessEscapeInRegex: -
	{ name: "OAUTH_TOKEN", regex: /ya29\.[A-Za-z0-9_\-]{16,}/g },
	// Local auth/config paths — redact user home directory paths that reveal
	// the OS user and expose config/credential file locations.
	{
		name: "LOCAL_PATH",
		regex: /(?:\/Users|\/home)[^\s"']*(?:\.config\/kimchi|\.ssh|\.aws|config\.json|credentials)[^\s"']*/g,
	},
	// Credential filenames in home directory
	{ name: "CREDENTIAL_FILE", regex: /~\/\.ssh\/[^\s"']+/g },
]

/**
 * JSON object keys whose string values should be redacted regardless of
 * whether the value matches a secret pattern. The key name itself signals
 * sensitivity.
 */
const SENSITIVE_KEYS = new Set([
	"password",
	"passwd",
	"pwd",
	"secret",
	"token",
	"accesstoken",
	"access_token",
	"refreshtoken",
	"refresh_token",
	"apikey",
	"api_key",
	"clientid",
	"client_id",
	"clientsecret",
	"client_secret",
	"privatekey",
	"private_key",
	"authorization",
	"auth",
])

function isSensitiveKey(key: string): boolean {
	const lower = key.toLowerCase()
	return SENSITIVE_KEYS.has(lower)
}

/**
 * Keys whose values are diagnostic identifiers (not secrets) and must
 * survive redaction unchanged. Trace IDs are captured from LLM provider
 * response headers and stored as `traceId` (string) or `traceIds` (string[]);
 * the bulkhead secret engine can false-positive on them.
 */
const PRESERVED_KEYS = new Set(["traceid", "traceids"])

function isPreservedKey(key: string): boolean {
	return PRESERVED_KEYS.has(key.toLowerCase())
}

/**
 * Apply custom regex patterns that the bulkhead engine does not cover.
 * This runs as a second pass after `engine.scan()`.
 */
function applyCustomPatterns(text: string): string {
	let result = text
	for (const { name, regex } of CUSTOM_PATTERNS) {
		result = result.replace(regex, (match, _group) => {
			// For patterns like "Bearer xxx", only redact the token part
			if (match.startsWith("Bearer ")) {
				return `Bearer [REDACTED-${name}]`
			}
			return `[REDACTED-${name}]`
		})
	}
	return result
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a single string for PII/secrets and return the redacted version.
 *
 * Runs the bulkhead engine first, then applies custom patterns (castai_v1_,
 * Bearer tokens, OAuth tokens) as a second pass.
 *
 * If scanning fails (engine error, unexpected input), the original text is
 * returned unchanged by default. Callers crossing a trust boundary can set
 * `failClosed` to throw instead. Fail-open errors are logged.
 */
export interface RedactionOptions {
	failClosed?: boolean
}

export async function redactText(text: string, options: RedactionOptions = {}): Promise<string> {
	try {
		const result = await getEngine().scan(text)
		const afterEngine = result.redactedText ?? text
		return applyCustomPatterns(afterEngine)
	} catch (err) {
		if (options.failClosed) throw err
		console.error("PII redaction scan failed, returning original text:", err)
		return text
	}
}

/**
 * Deep-walk any JSON-serializable structure and redact all string values.
 *
 * Unlike `redactMessages`, which only scans `type:"text"` content blocks,
 * this function walks **every** string in the object tree — including
 * tool-call arguments, tool results, metadata fields, etc. This is the
 * right tool for export transcripts where secrets can appear anywhere.
 *
 * Additionally, values stored under sensitive keys (password, token, secret,
 * auth, apiKey, etc.) are redacted regardless of whether the value matches
 * a secret pattern — the key name itself signals sensitivity.
 *
 * Returns a **new** structure; the input is never mutated.
 *
 * @param obj      Any JSON-serializable value (object, array, primitive)
 * @param options  Set `failClosed` when unredacted data must not escape
 * @returns        Deep clone with all string values redacted
 */
export async function redactObjectStrings<T>(obj: T, options: RedactionOptions = {}): Promise<T> {
	if (typeof obj === "string") {
		return (await redactText(obj, options)) as T
	}
	if (Array.isArray(obj)) {
		return Promise.all(obj.map((item) => redactObjectStrings(item, options))) as Promise<T>
	}
	if (obj !== null && typeof obj === "object") {
		const entries = Object.entries(obj as Record<string, unknown>)
		const values = await Promise.all(
			entries.map(([key, value]) => {
				// Trace IDs are diagnostic identifiers, not secrets — pass through
				// unchanged (handles both `traceId: string` and `traceIds: string[]`).
				if (isPreservedKey(key)) {
					return Promise.resolve(value)
				}
				// Redact any string value stored under a sensitive key name.
				if (typeof value === "string" && isSensitiveKey(key)) {
					return Promise.resolve("[REDACTED-SECRET_FIELD]")
				}
				return redactObjectStrings(value, options)
			}),
		)
		const result: Record<string, unknown> = {}
		for (let i = 0; i < entries.length; i++) {
			result[entries[i][0]] = values[i]
		}
		return result as T
	}
	return obj
}

/** A pi-ai message with optional role/content fields. */
interface AnyMessage {
	role?: string
	content?: unknown
}

/**
 * Redact PII and secrets from a pi-ai message array.
 *
 * Deep-walks every non-system message — including tool-call arguments,
 * tool-result content, and any other string fields — replacing matched
 * PII/secret spans with `[REDACTED-TYPE]` markers. Returns a **new**
 * array; the input is never mutated.
 *
 * @param messages  pi-ai `Message[]` (the output of `convertToLlm`)
 * @returns          New array with all string values redacted; input untouched
 */
export async function redactMessages(messages: unknown[]): Promise<unknown[]> {
	return Promise.all(
		messages.map(async (msg) => {
			if (msg === null || typeof msg !== "object") return msg
			const message = msg as AnyMessage
			// Skip system messages — they contain structural identifiers
			// (ferment IDs, session IDs) that must not be redacted.
			if (message.role === "system") return msg
			return redactObjectStrings(msg)
		}),
	)
}
