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
import { getDefaultExcludedEntities } from "./entity-tiers.js"

/**
 * One atomic view of the redaction policy: the engine, the engine-level
 * exclusion set, and the raw user exclusion list, resolved together.
 *
 * A mid-flight settings edit rebuilds `current` wholesale; in-flight callers
 * keep the snapshot they resolved at pass entry, so a single redaction pass
 * never mixes the old engine policy with the new custom-pattern policy (the
 * pre-snapshot design read the module globals after an await, which let a
 * concurrent rebuild land between the two passes). The superseded engine is
 * simply GC'd — never disposed — so in-flight scans are unaffected.
 */
interface EngineSnapshot {
	engine: GuardrailsEngine
	exclusions: ReadonlySet<string>
	userExclusions: ReadonlySet<string>
	/** Joined exclusion signature the snapshot was built from. */
	signature: string
}

let current: EngineSnapshot | undefined
let configError: Error | undefined

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
 * Resolve the current policy snapshot for the resolved exclusion config.
 * Rebuilds when the resolved exclusion list changes (e.g. a mid-session
 * settings.json edit), so the ACP host picks up new exclusions without a
 * restart. The comparison is a joined-string signature — O(list), no
 * per-call engine construction.
 *
 * A broken `redaction.excludedEntities` settings block must not turn
 * redaction off: the lenient paths (hooks, bug report) would silently pass
 * text through and the operator's only signal would be a per-event log.
 * Instead the snapshot degrades to the registry defaults, the error is
 * remembered for the strict export path (which fails closed on it), and it
 * is logged once here, loudly.
 */
function resolveSnapshot(): EngineSnapshot {
	let config: ReturnType<typeof getRedactionConfig>
	try {
		config = getRedactionConfig()
		configError = undefined
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err))
		if (configError?.message !== error.message) {
			console.error(
				`[pii-redaction] ${error.message} — using default exclusions; exports will fail until settings.json is fixed.`,
			)
		}
		configError = error
		config = { enabled: true, excludedEntities: getDefaultExcludedEntities(), userExcludedEntities: [] }
	}
	const signature = [config.excludedEntities.join("\u0001"), config.userExcludedEntities.join("\u0001")].join("\u0002")
	if (current && signature === current.signature) return current
	current = {
		engine: createRedactionEngine(config.excludedEntities),
		exclusions: new Set(config.excludedEntities),
		userExclusions: new Set(config.userExcludedEntities),
		signature,
	}
	return current
}

/**
 * The settings error the current snapshot degraded on, if any. The strict
 * export path fails closed on this instead of exporting with fallback
 * exclusions the operator did not write down.
 */
export function getRedactionConfigError(): Error | undefined {
	return configError
}

/** Reset the cached engine — for test isolation. */
export function resetRedactorEngine(): void {
	current = undefined
	configError = undefined
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
	// Bearer tokens (Authorization header or standalone). Anchor is captured
	// so the splice preserves the original prefix byte-for-byte (case included).
	// biome-ignore lint/complexity/noUselessEscapeInRegex: -
	{ name: "BEARER_TOKEN", regex: /(bearer\s+)([A-Za-z0-9_\-\.]{16,})/gi, secretGroup: 2 },
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
	// over-covered: userinfo credentials (`scheme://user:pass@host` — both
	// parts redacted; scheme and host kept for diagnostics) and secret-shaped
	// query parameters (`?token=…`, `?api_key=…`).
	{
		name: "URL_WITH_CREDENTIALS",
		regex: /(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s:@]+:[^@\s/]+)(@[^\s/]+)/g,
		secretGroup: 2,
	},
	// Query parameters that carry credentials. `;` is included as a leading
	// separator for `;`-delimited connection strings (Azure SAS).
	{
		name: "URL_WITH_CREDENTIALS",
		regex:
			/([?&;](?:token|api_?key|key|sig|signature|secret|password|access_token|refresh_token|session_token|client_secret|sas|sharedaccesssignature)=)([^&;\s]{8,})/gi,
		secretGroup: 2,
	},
	// Keyword-anchored re-additions for bare-shape engine entities the tier
	// registry excludes (TELEGRAM_BOT_TOKEN, OKTA_TOKEN): the bare shapes
	// collide with common text, but behind their keyword they are secrets.
	{
		name: "TELEGRAM_BOT_TOKEN",
		regex: /((?:telegram|tg)[_-]?bot[_-]?token\s*[:=]\s*["']?)([0-9]{8,10}:[A-Za-z0-9_-]{35})/gi,
		secretGroup: 2,
	},
	// Okta tokens vary in length (SSWS-prefixed are 44); the keyword anchor
	// carries the precision, so the value range is deliberately loose.
	{
		name: "OKTA_TOKEN",
		regex: /(okta(?:_api)?_token\s*[:=]\s*["']?)([A-Za-z0-9_-]{40,44})/gi,
		secretGroup: 2,
	},
	// Keyword-anchored free-text secrets: `password: …`, `secret = …`,
	// `token: …`, `credential: …`. Restores the engine's GENERIC_SECRET
	// coverage (anchor_required, excluded by default) for the free-text case
	// the JSON sensitive-key path cannot see. Value charset excludes `[` so
	// an earlier pattern's `[REDACTED-…]` marker is never re-consumed.
	{
		name: "GENERIC_SECRET",
		regex:
			/((?:api[_-]?|access[_-]?)?(?:secret|password|passwd|token|credential|credentials)\s*[:=]\s*["']?)([^\s"'[]{16,})/gi,
		secretGroup: 2,
	},
	// Docker registry auth from a config's JSON `"auth"` key (base64 of
	// user:password). Restores DOCKER_REGISTRY_AUTH coverage.
	{
		name: "DOCKER_REGISTRY_AUTH",
		regex: /("auth"\s*:\s*")([A-Za-z0-9+/=]{16,})"/g,
		secretGroup: 2,
	},
]

/**
 * Distinct entity names emitted by CUSTOM_PATTERNS. Exported so the
 * entity-tiers registry test can enforce that every custom marker type is
 * a known entity — an unregistered name could never appear in
 * `redaction.excludedEntities` (validation throws), silently making the
 * pattern un-excludable.
 */
export const CUSTOM_PATTERN_NAMES: readonly string[] = [...new Set(CUSTOM_PATTERNS.map((p) => p.name))]

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
	"auth",
	// `auth` stays on: an opaque token under {"auth": "…"} is common (docker
	// registry configs). OAuth identifier keys remain out — client_id/clientid
	// are public, and redacting them destroys configs for zero gain.
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
	excluded: ReadonlySet<string>,
	onMatch?: (match: { name: string; secret: string }) => void,
): string {
	let result = text
	for (const { name, regex, secretGroup } of CUSTOM_PATTERNS) {
		if (excluded.has(name)) continue
		const marker = `[REDACTED-${name}]`
		result = result.replace(regex, (match, ...args: unknown[]) => {
			if (secretGroup !== undefined) {
				// Replace by POSITION, never by substring search: the secret's text
				// can also occur inside the anchor (user == password URLs, keyword
				// prefixes containing the secret), and a substring replace would
				// marker the anchor and leak the secret. The anchored patterns all
				// cover their match with capture groups, so splice from the groups
				// the callback hands us (offset + input trail the rest args).
				const groups = args.slice(0, -2)
				const secret = groups[secretGroup - 1]
				if (typeof secret === "string" && secret.length > 0) {
					onMatch?.({ name, secret })
					const parts = groups.map((g) => (typeof g === "string" ? g : ""))
					const prefix = parts.slice(0, secretGroup - 1).join("")
					const tail = parts.slice(secretGroup).join("")
					if (prefix.length + secret.length + tail.length === match.length) {
						return `${prefix}${marker}${tail}`
					}
					// Groups no longer tile the match (future pattern drift) — fail
					// safe by redacting the whole match rather than searching.
					return marker
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
async function redactTextWithSnapshot(text: string, snapshot: EngineSnapshot): Promise<string> {
	const afterEngine = await detectAndCompose(text, snapshot.engine, snapshot.exclusions)
	return applyCustomPatterns(afterEngine, snapshot.userExclusions)
}

export async function redactTextOrThrow(text: string): Promise<string> {
	return redactTextWithSnapshot(text, resolveSnapshot())
}

/**
 * Shared fail-open core behind `redactText` and the measured variant: scan,
 * and on engine failure return the original text unchanged. `onFailure` is
 * called with the thrown error so callers can count failures; whether (and
 * how often) to log is the caller's decision — the measured variant logs
 * once per invocation, not once per string, so a degraded engine cannot
 * flood stderr with a stack trace per scanned string in a large context.
 */
async function redactTextCounted(text: string, onFailure?: (err: unknown) => void): Promise<string> {
	try {
		return await redactTextWithSnapshot(text, resolveSnapshot())
	} catch (err) {
		onFailure?.(err)
		return text
	}
}

export async function redactText(text: string): Promise<string> {
	return redactTextCounted(text, (err) => console.error("PII redaction scan failed, returning original text:", err))
}

/**
 * Deep-walk any JSON-serializable structure and redact all string values.
 *
 * Shared walker for the lenient and strict public variants — identical
 * semantics: every string walked, trace-ID keys passed through unchanged,
 * sensitive-key string values force-redacted, enumerable symbols preserved.
 * Only the per-string redaction function differs (fail-open vs fail-closed).
 */
async function redactObjectStringsWith<T>(
	obj: T,
	redactString: (text: string) => Promise<string>,
	snapshot: EngineSnapshot,
	onScannedPair?: (input: string, output: string) => void,
): Promise<T> {
	if (typeof obj === "string") {
		const out = await redactString(obj)
		onScannedPair?.(obj, out)
		return out as T
	}
	if (Array.isArray(obj)) {
		return Promise.all(obj.map((item) => redactObjectStringsWith(item, redactString, snapshot, onScannedPair))) as Promise<T>
	}
	if (obj !== null && typeof obj === "object") {
		// The snapshot was resolved once at the pass entry — the sensitive-key
		// policy below is the same atomic view the string scans use, even if a
		// concurrent settings edit rebuilds the engine mid-walk.
		const secretFieldRedacts = !snapshot.userExclusions.has("SECRET_FIELD")
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
					onScannedPair?.(value, "[REDACTED-SECRET_FIELD]")
					return Promise.resolve("[REDACTED-SECRET_FIELD]")
				}
				return redactObjectStringsWith(value, redactString, snapshot, onScannedPair)
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
	// One config resolution per pass: the per-string callback is bound to the
	// entry snapshot, so a deep-walk export pays one policy read, not two
	// statSync calls per string. Mid-session edits are honored by the next
	// pass re-resolving at its entry.
	const snapshot = resolveSnapshot()
	return redactObjectStringsWith(
		obj,
		(text) =>
			redactTextWithSnapshot(text, snapshot).catch((err) => {
				console.error("PII redaction scan failed, returning original text:", err)
				return text
			}),
		snapshot,
	)
}

// ---------------------------------------------------------------------------
// Measured variant — redaction + a privacy-safe report stub
// ---------------------------------------------------------------------------

/** Marker every redaction pass converges on: `[REDACTED-<ENTITY_TYPE>]`. */
const REDACTION_MARKER_RE = /\[REDACTED-([A-Z0-9_]+)\]/g

/**
 * Tally markers INTRODUCED by a single string's redaction pass. Markers
 * already present in the input (e.g. text redacted by an earlier hook —
 * message_end scrubs messages before before_provider_request re-scans them)
 * must not be counted again, or every repeat pass double-reports the same
 * redaction. Input and output are matched as multisets: only output markers
 * with no matching input marker increment the tally.
 */
function tallyMarkersNet(input: string, output: string, entities: Record<string, number>): void {
	// Cheap path first: most strings contain no markers at all — one output
	// sweep, and only when markers exist do we pay for the input multiset.
	const outMarkers = [...output.matchAll(REDACTION_MARKER_RE)]
	if (outMarkers.length === 0) return
	const available = new Map<string, number>()
	for (const match of input.matchAll(REDACTION_MARKER_RE)) {
		available.set(match[1], (available.get(match[1]) ?? 0) + 1)
	}
	for (const match of outMarkers) {
		const entityType = match[1]
		const preExisting = available.get(entityType) ?? 0
		if (preExisting > 0) {
			available.set(entityType, preExisting - 1)
			continue
		}
		entities[entityType] = (entities[entityType] ?? 0) + 1
	}
}

export interface RedactionReport {
	/**
	 * Entity-type tally: marker name (EMAIL_ADDRESS, GITHUB_TOKEN,
	 * SECRET_FIELD, ...) → occurrences redacted across all scanned strings.
	 * Privacy-safe by construction — it is tallied from redacted output only,
	 * so only `[REDACTED-TYPE]` marker names can ever land in the map. Markers
	 * already present in the input are netted out, so a re-scan of previously
	 * redacted text reports no new redactions.
	 */
	entities: Record<string, number>
	/** Non-empty strings scanned (values force-redacted via a sensitive key name are not scanned). */
	stringsScanned: number
	/** Engine scans that failed open (original text returned). */
	engineFailures: number
}

export interface RedactionMeasurement<T> {
	redacted: T
	report: RedactionReport
}

/**
 * Measured variant of `redactObjectStrings`: identical redaction semantics
 * (lenient fail-open, sensitive-key force-redaction, preserved trace IDs),
 * plus a tally of which entity types were redacted and how many engine
 * scans failed. Emitted by the hooks as `pii_redaction:redacted` events.
 *
 * The tally counts markers newly introduced in the redacted output —
 * uniform across the bulkhead engine's findings and the custom-pattern
 * second pass, so no engine API coupling is introduced, and repeat passes
 * over already-redacted text (message_end → before_provider_request) do
 * not double-count.
 */
export async function redactObjectStringsMeasured<T>(obj: T): Promise<RedactionMeasurement<T>> {
	const report: RedactionReport = { entities: {}, stringsScanned: 0, engineFailures: 0 }
	let failureLogged = false
	// One snapshot per measured pass — the SECRET_FIELD gate and every string
	// scan see the same atomic policy view, exactly like the lenient variant.
	const snapshot = resolveSnapshot()
	const redactStringMeasured = async (text: string): Promise<string> => {
		if (text.length === 0) return text
		report.stringsScanned += 1
		try {
			return await redactTextWithSnapshot(text, snapshot)
		} catch (err) {
			report.engineFailures += 1
			// One log per invocation: a persistently degraded engine would
				// otherwise print a stack trace per scanned string per hook.
			if (!failureLogged) {
				failureLogged = true
				console.error("PII redaction scan failed, returning original text:", err)
			}
			return text
		}
	}
	const redacted = await redactObjectStringsWith(obj, redactStringMeasured, snapshot, (input, output) =>
		tallyMarkersNet(input, output, report.entities),
	)
	return { redacted, report }
}

/** An empty report — the starting point for cross-invocation aggregation. */
export function emptyRedactionReport(): RedactionReport {
	return { entities: {}, stringsScanned: 0, engineFailures: 0 }
}

/** Merge `source` into `target` in place (both shaped as {@link RedactionReport}). */
export function mergeReports(target: RedactionReport, source: RedactionReport): void {
	target.stringsScanned += source.stringsScanned
	target.engineFailures += source.engineFailures
	for (const [entity, count] of Object.entries(source.entities)) {
		target.entities[entity] = (target.entities[entity] ?? 0) + count
	}
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
	const snapshot = resolveSnapshot()
	// Fail closed on a broken settings block: exporting with fallback
	// exclusions the operator did not write down would publish a transcript
	// redacted under a policy nobody chose. The lenient paths already
	// degraded to defaults with a loud log; here the error must stop the
	// export so the operator fixes settings.json first.
	const settingsError = getRedactionConfigError()
	if (settingsError) {
		throw new Error(`redaction settings invalid: ${settingsError.message}`)
	}
	return redactObjectStringsWith(obj, (text) => redactTextWithSnapshot(text, snapshot), snapshot)
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
