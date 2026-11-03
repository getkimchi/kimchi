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
 * not cover them. Context-free detectors (bare shapes: dates, national IDs,
 * unsigned secrets) are excluded via the tier registry in `entity-tiers.ts`;
 * their keyword-anchored variants live in the custom second pass.
 *
 * The engine is lazily initialized — `createEngine()` instantiates guard
 * objects with compiled regex patterns, which is cheap. The cached instance is
 * stateless (no per-session data) so it does not leak across sessions or tests.
 * `resetRedactorEngine()` is exported for test isolation.
 */

import { type BulkheadConfig, createEngine, DEFAULT_CONFIG, type GuardrailsEngine } from "@bulkhead-ai/core"
import { getRedactionConfig } from "./config.js"

let engine: GuardrailsEngine | undefined
let engineExclusionsSignature = ""
let engineExclusions: ReadonlySet<string> = new Set()
let userExclusions: ReadonlySet<string> = new Set()

/**
 * Create a fresh redaction engine with the given entity exclusions applied.
 *
 * PiiGuard covers emails, phones, SSNs, credit cards (Luhn), IBANs (mod-97).
 * SecretGuard covers API keys, Bearer tokens, AWS keys, GitHub tokens.
 * Injection and content-safety guards are disabled — not relevant to PII
 * scrubbing.
 *
 * Exported (not module-private) so analysis tooling (the shadow-mode
 * script) and tests can build engines with explicit policies without
 * touching the process-wide singleton.
 */
export function createRedactionEngine(excludedEntities: readonly string[]): GuardrailsEngine {
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
	const fresh = createEngine(config)
	// Tier-driven exclusions: bare-shape detectors false-fire constantly in
	// an engineering corpus (SHAs, timestamps, digit runs) — see
	// entity-tiers.ts. GUID stays out: structural identifiers, not PII.
	fresh.setExcludeEntities([...excludedEntities])
	return fresh
}

/**
 * Get or create the singleton engine for the current exclusion config.
 * Rebuilds when the resolved exclusion list changes (e.g. a mid-session
 * settings.json edit), so the ACP host picks up new exclusions without a
 * restart. The comparison is a joined-string signature — O(list), no
 * per-call engine construction.
 */
function getEngine(): GuardrailsEngine {
	const config = getRedactionConfig()
	const signature = [config.excludedEntities.join("\u0001"), config.userExcludedEntities.join("\u0001")].join("\u0002")
	if (engine && signature === engineExclusionsSignature) return engine
	engine = createRedactionEngine(config.excludedEntities)
	engineExclusionsSignature = signature
	engineExclusions = new Set(config.excludedEntities)
	userExclusions = new Set(config.userExcludedEntities)
	return engine
}

/** Reset the cached engine — for test isolation. */
export function resetRedactorEngine(): void {
	engine = undefined
	engineExclusionsSignature = ""
	engineExclusions = new Set()
	userExclusions = new Set()
}

// ---------------------------------------------------------------------------
// Exclusion-correct composition
// ---------------------------------------------------------------------------

interface EngineDetection {
	entityType: string
	start: number
	end: number
	/** The matched original text (for analysis tooling; never logged). */
	text: string
}

/**
 * Detect + compose `[REDACTED-TYPE]` replacements ourselves instead of
 * trusting `engine.scan().redactedText`: bulkhead's multi-guard rebuild
 * mis-pairs detections with replacement entries, so with exclusions active
 * the returned text can carry markers for EXCLUDED entities while its
 * `redactionMap` claims they were filtered (verified empirically — an
 * excluded DATABASE_CONNECTION_STRING marker landed in text whose map held
 * only EMAIL_ADDRESS). `analyze()` + our own composition is deterministic:
 *
 * - detections on the exclusion list are dropped before composition
 * - overlapping detections resolve greedily: earliest start wins, then the
 *   LONGEST span (redact more, not less, when they collide)
 * - replacements spliced right-to-left so offsets stay valid
 *
 * Engine configuration involves no synthesizers/temporal policy, so
 * analyze-only composition loses nothing against scan().
 */

/**
 * Detection pass shared by composition and analysis tooling: analyze, drop
 * excluded entities, then greedily resolve overlaps.
 */
export async function collectDetections(
	text: string,
	engine: GuardrailsEngine,
	excluded: ReadonlySet<string>,
): Promise<EngineDetection[]> {
	const results = await engine.analyze(text)
	const active: EngineDetection[] = []
	for (const r of results) {
		for (const d of r.detections) {
			if (!excluded.has(d.entityType))
				active.push({ entityType: d.entityType, start: d.start, end: d.end, text: d.text })
		}
	}
	const byStart = [...active].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
	const kept: EngineDetection[] = []
	let coveredUntil = -1
	for (const d of byStart) {
		if (d.start >= coveredUntil) {
			kept.push(d)
			coveredUntil = d.end
		}
	}
	return kept
}

/** Splice kept detections into markers, right-to-left so offsets hold. */
export function composeRedactedText(text: string, kept: EngineDetection[]): string {
	let out = text
	for (const d of [...kept].sort((a, b) => b.start - a.start)) {
		out = `${out.slice(0, d.start)}[REDACTED-${d.entityType}]${out.slice(d.end)}`
	}
	return out
}

/**
 * Run the engine's detection pass and return composed, exclusion-filtered
 * text. Exported for the shadow-mode analysis script and tier tests —
 * passing `engine` explicitly avoids the process-wide singleton.
 */
export async function detectAndCompose(
	text: string,
	engine: GuardrailsEngine,
	excluded: ReadonlySet<string>,
): Promise<string> {
	return composeRedactedText(text, await collectDetections(text, engine, excluded))
}

// ---------------------------------------------------------------------------
// Custom redaction patterns not covered by @bulkhead-ai/core
// ---------------------------------------------------------------------------

interface CustomPattern {
	name: string
	regex: RegExp
	/**
	 * When set, only this capture group is replaced by the marker; the rest
	 * of the match (the anchoring context) survives. Group 1 must be the
	 * anchor, group 2 the secret. Bare patterns (no secretGroup) replace the
	 * whole match, which is correct for prefixed shapes.
	 */
	secretGroup?: number
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
	// OpenAI-style API keys (sk-, sk-proj-, sk-ant-, sk-conv-) — the bulkhead
	// secret engine's key guard misses the newer prefixed formats (verified:
	// sk-proj-… passes through untouched, and exported such a key once).
	{ name: "OPENAI_API_KEY", regex: /\bsk-[A-Za-z0-9_-]{10,}\b/g },
	// GitHub tokens outside a KEY=value assignment — bulkhead only catches
	// them behind "TOKEN=". Covers personal/oauth/user-to-server/
	// server-to-server/refresh prefixes (ghp_, gho_, ghu_, ghs_, ghr_) and
	// fine-grained PATs.
	{ name: "GITHUB_TOKEN", regex: /\bgh[pousr]_[A-Za-z0-9]{10,}\b/g },
	{ name: "GITHUB_TOKEN", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
	// Local auth/config paths — redact user home directory paths that reveal
	// the OS user and expose config/credential file locations.
	{
		name: "LOCAL_PATH",
		regex: /(?:\/Users|\/home)[^\s"']*(?:\.config\/kimchi|\.ssh|\.aws|config\.json|credentials)[^\s"']*/g,
	},
	// Credential filenames in home directory
	{ name: "CREDENTIAL_FILE", regex: /~\/\.ssh\/[^\s"']+/g },
	// ── Anchored re-additions for anchor_required engine entities ──────────
	// These honor the bare secret shape only when context vouches for it —
	// the engine's context-free versions are excluded via entity-tiers.
	// AWS secret keys behind their keyword (a bare 40-char base64 run is a
	// temp path or hash far more often than a secret). Value length is
	// deliberately loose — the keyword carries the precision, and the export
	// path is fail-closed: a truncated or padded key must still redact.
	{
		name: "AWS_SECRET_KEY",
		regex: /(aws_secret(?:_access)?_key\s*[:=]\s*["']?)([A-Za-z0-9/+=]{16,})/gi,
		secretGroup: 2,
	},
	// Azure storage keys inside a connection string.
	{
		name: "AZURE_STORAGE_KEY",
		regex: /(AccountKey=)([A-Za-z0-9+/]{40,}={0,2})/g,
		secretGroup: 2,
	},
	// Basic-auth header values.
	{
		name: "BASIC_AUTH",
		regex: /(Authorization:\s*Basic\s+)([A-Za-z0-9+/=]{8,})/gi,
		secretGroup: 2,
	},
	// Credentials in URLs, which the engine's URL redaction previously
	// over-covered: userinfo passwords (`scheme://user:pass@host`) and
	// secret-shaped query parameters (`?token=…`, `?api_key=…`).
	{
		name: "URL_WITH_CREDENTIALS",
		regex: /(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s/]+)(@[^\s/]+)/g,
		secretGroup: 2,
	},
	{
		name: "URL_WITH_CREDENTIALS",
		regex: /([?&](?:token|api_?key|key|sig|signature|secret|password|access_token)=)([^&\s]{8,})/gi,
		secretGroup: 2,
	},
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
	"clientsecret",
	"client_secret",
	"privatekey",
	"private_key",
	"authorization",
	// client_id/clientid and bare "auth" deliberately absent: identifiers,
	// not secrets — redacting them destroys OAuth configs for zero gain.
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
 *
 * Patterns whose name is in the USER-supplied exclusion list are skipped —
 * the user's `redaction.excludedEntities` governs kimchi-owned markers
 * (e.g. LOCAL_PATH). Registry defaults never filter customs: they exclude
 * anchor-required entities at the ENGINE so their anchored re-additions
 * here can fire (see config.ts / entity-tiers.ts).
 */
export function applyCustomPatterns(
	text: string,
	excluded: ReadonlySet<string> = userExclusions,
	onMatch?: (match: { name: string; secret: string }) => void,
): string {
	let result = text
	for (const { name, regex, secretGroup } of CUSTOM_PATTERNS) {
		if (excluded.has(name)) continue
		const marker = `[REDACTED-${name}]`
		result = result.replace(regex, (match, ...args: unknown[]) => {
			// For patterns like "Bearer xxx", only redact the token part
			if (name === "BEARER_TOKEN") {
				onMatch?.({ name, secret: match })
				return `Bearer ${marker}`
			}
			if (secretGroup !== undefined) {
				// Capture groups precede offset/string in the rest args.
				const secret = args[secretGroup - 1]
				if (typeof secret === "string" && secret.length > 0) {
					onMatch?.({ name, secret })
					return match.replace(secret, marker)
				}
			}
			onMatch?.({ name, secret: match })
			return marker
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
 * returned unchanged — redaction must never break the prompt pipeline.
 * The error is logged per the code-review-lessons rule: no empty catch blocks.
 */
export async function redactTextOrThrow(text: string): Promise<string> {
	const theEngine = getEngine()
	const afterEngine = await detectAndCompose(text, theEngine, engineExclusions)
	return applyCustomPatterns(afterEngine)
}

export async function redactText(text: string): Promise<string> {
	try {
		return await redactTextOrThrow(text)
	} catch (err) {
		console.error("PII redaction scan failed, returning original text:", err)
		return text
	}
}

/**
 * Deep-walk any JSON-serializable structure and redact all string values.
 *
 * Shared walker for the lenient and strict public variants — identical
 * semantics: every string walked, trace-ID keys passed through unchanged,
 * sensitive-key string values force-redacted, enumerable symbols preserved.
 * Only the per-string redaction function differs (fail-open vs fail-closed).
 */
async function redactObjectStringsWith<T>(obj: T, redactString: (text: string) => Promise<string>): Promise<T> {
	if (typeof obj === "string") {
		return (await redactString(obj)) as T
	}
	if (Array.isArray(obj)) {
		return Promise.all(obj.map((item) => redactObjectStringsWith(item, redactString))) as Promise<T>
	}
	if (obj !== null && typeof obj === "object") {
		// Prime the engine (and with it the user-exclusion set) before any
		// sensitive-key checks below — a top-level {password: "…"} input must
		// not read the set before the first scan happens.
		getEngine()
		const secretFieldRedacts = !userExclusions.has("SECRET_FIELD")
		const source = obj as Record<PropertyKey, unknown>
		const keys: PropertyKey[] = [
			...Object.keys(source),
			...Object.getOwnPropertySymbols(source).filter((key) => Object.prototype.propertyIsEnumerable.call(source, key)),
		]
		const values = await Promise.all(
			keys.map((key) => {
				const value = source[key]
				// Trace IDs are diagnostic identifiers, not secrets — pass through
				// unchanged (handles both `traceId: string` and `traceIds: string[]`).
				if (typeof key === "string" && isPreservedKey(key)) {
					return Promise.resolve(value)
				}
				// Redact any string value stored under a sensitive key name.
				if (secretFieldRedacts && typeof key === "string" && typeof value === "string" && isSensitiveKey(key)) {
					return Promise.resolve("[REDACTED-SECRET_FIELD]")
				}
				return redactObjectStringsWith(value, redactString)
			}),
		)
		const result: Record<PropertyKey, unknown> = {}
		for (let i = 0; i < keys.length; i++) {
			result[keys[i]] = values[i]
		}
		return result as T
	}
	return obj
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
 * Lenient failure policy: a scanning failure falls back to the original text
 * (via `redactText`) — redaction must never break the prompt pipeline.
 *
 * @param obj  Any JSON-serializable value (object, array, primitive)
 * @returns     Deep clone with all string values redacted
 */
export async function redactObjectStrings<T>(obj: T): Promise<T> {
	return redactObjectStringsWith(obj, redactText)
}

/**
 * Strict variant of `redactObjectStrings` for the export pipeline.
 *
 * Identical walk semantics — every string, sensitive-key force-redaction,
 * preserved trace IDs, symbols kept — but built on `redactTextOrThrow`: an
 * engine/scan failure **propagates** instead of silently returning the
 * original text. Exports fail closed — an unredacted transcript must never
 * be published.
 *
 * Returns a **new** structure; callers must assign the result.
 */
export async function redactObjectStringsStrict<T>(obj: T): Promise<T> {
	return redactObjectStringsWith(obj, redactTextOrThrow)
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
