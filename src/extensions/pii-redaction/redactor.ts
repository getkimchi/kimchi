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
import { getManagedRedactionPolicy, getRedactionConfig, type RedactionRenderMode } from "./config.js"
import { type RedactionPattern, resolveRedactionPolicy } from "./policy.js"
import { TOKENIZED_ENTITIES, type TokenVault, tokenFor, tokensToMarkers } from "./vault.js"

/**
 * One atomic view of the redaction policy: the engine, the resolved
 * policy, and the render mode, resolved together.
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
	renderMode: RedactionRenderMode
	/** Entities whose non-engine coverage is suspended (custom patterns, SECRET_FIELD). */
	disabled: ReadonlySet<string>
	/** Built-in customs plus any user-defined patterns, joined once at build time. */
	patterns: readonly RedactionPattern[]
	/** Universe entity → category, for telemetry attribution. */
	categories: ReadonlyMap<string, string>
	/** Joined policy signature the snapshot was built from. */
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
 * A broken `redaction` settings block must not turn redaction off: the
 * lenient paths (hooks, bug report) would silently pass text through and
 * the operator's only signal would be a per-event log. Instead the snapshot
 * degrades to the registry defaults, the error is remembered for the strict
 * export path (which fails closed on it), and it is logged once here,
 * loudly.
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
				`[pii-redaction] ${error.message} — using default redaction policy; exports will fail until settings.json is fixed.`,
			)
		}
		configError = error
		// Keep the org's own rules live — its policy parses independently and
		// must not fall off because of a local settings typo it did not write.
		config = { enabled: true, renderMode: "markers", resolved: resolveRedactionPolicy(getManagedRedactionPolicy()) }
	}
	const signature = [config.resolved.signature, config.renderMode].join("\u0002")
	if (current && signature === current.signature) return current
	current = {
		engine: createRedactionEngine(config.resolved.engineExclusions),
		exclusions: new Set(config.resolved.engineExclusions),
		renderMode: config.renderMode,
		disabled: config.resolved.disabledEntities,
		// Joined once here — the per-scan loop must not re-allocate on every string.
		patterns: [...CUSTOM_PATTERNS, ...config.resolved.customPatterns],
		categories: config.resolved.categories,
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
// Precision defaults — detections that identify nobody
// ---------------------------------------------------------------------------
//
// The engine optimises for recall: a shape that *could* be an address or an IP
// is reported. In an engineering corpus that costs precision — a two-week
// replay of 701 real transcripts measured ~9,700 email/IP detections of which
// ~5,300 were technical identifiers, not personal data (package paths read as
// addresses, `127.0.0.1` in dev-server URLs, the harness's own co-author line).
//
// The defaults below narrow detection after the engine has spoken, expressed
// as small lookup tables plus one predicate per entity. Every rule fails
// toward redaction: an unparseable span, an unknown entity type, a dotless
// intranet host (`.internal`, `.local`, `user@mailserver`), a mixed-case
// domain, a Unicode or punycode TLD, a consumer mail domain with a numeric
// label (`163.com`, `126.com`), or a role address whose `+tag` carries an
// identifier (`noreply+jane.doe@`) is kept. Reserved namespaces
// (`example.com`, `.invalid`, `.test`) are deliberately still redacted — they
// are the ecosystem's stand-in for an address, and a precision fix should not
// change what a test fixture denotes.
//
// No rule inspects a matched value's content beyond its shape — nothing logs,
// stores, or returns the span.

/** File/code suffixes that can never be a top-level domain. */
const NON_TLD_SUFFIXES = new Set([
	"patch",
	"path",
	"json",
	"jsonl",
	"lockfile",
	"toml",
	"yaml",
	"yml",
	"tsx",
	"jsx",
	"darwin",
	"linux",
	"win32",
	"dylib",
	"exe",
	"map",
	"css",
	"png",
	"svg",
	"html",
])

/**
 * Role mailboxes that never identify a person. Kept deliberately short: the
 * list is matched on the local part only, so a longer list starts hitting real
 * shared inboxes (`support@` at a small company is a person's job).
 */
const GENERIC_LOCAL_PARTS = new Set(["noreply", "no-reply", "git", "bot", "nobody", "mailer-daemon"])

/**
 * Tags that describe a mailbox's function, not a person. A role address with
 * an operational tag (`bot+notifications@`) is a measured false-positive
 * family; a personal tag (`noreply+jane.doe@`) can carry an identifier, so it
 * stays redacted.
 */
const OPERATIONAL_TAGS = new Set([
	"notifications",
	"notification",
	"noreply",
	"no-reply",
	"bounce",
	"bounces",
	"alerts",
	"alert",
	"updates",
	"update",
	"digest",
	"newsletter",
	"unsubscribe",
	"automated",
	"system",
	"mail",
])

/**
 * The harness's own commit identity. Exact address only — never a domain
 * wildcard, which would let any real `*@kimchi.dev` employee address through.
 */
const SELF_IDENTITY_ADDRESSES = new Set(["noreply@kimchi.dev"])

function splitAddress(span: string): { local: string; domain: string } | undefined {
	const at = span.lastIndexOf("@")
	if (at <= 0 || at === span.length - 1) return undefined
	return { local: span.slice(0, at).toLowerCase(), domain: span.slice(at + 1).toLowerCase() }
}

/** The engine's own identity, so generated commit trailers survive redaction. */
export function isSelfIdentity(span: string): boolean {
	return SELF_IDENTITY_ADDRESSES.has(span.toLowerCase())
}

/**
 * Whether the domain is structurally a domain rather than a versioned package
 * path. Rejects pure-numeric labels (`1.3.0.patch`, `v0.0.1-go1.26.5.darwin`),
 * double-underscore package scopes, and non-TLD suffixes.
 *
 * Deliberately NOT rejected: `.zip` and `.mov` (both real gTLDs), `.md`/`.sh`/
 * `.so` (real ccTLDs), IDN `xn--` domains, and any alphabetic TLD — a
 * file-extension deny-list wide enough to catch every path-shaped match would
 * start dropping real addresses.
 */
export function isTechnicalEmailDomain(domain: string): boolean {
	// Normalised here so an external caller cannot misclassify a mixed-case
	// domain (`Corp.COM`) and drop a real address.
	const lower = domain.toLowerCase()
	if (lower.includes("__")) return true
	const labels = lower.split(".")
	if (labels.length < 2) return false
	// Two or more purely numeric labels only appear in version strings
	// (`1.3.0.patch`, `v0.0.1-go1.26.5.darwin`). ONE numeric label is a real
	// domain — 163.com, 126.com, 189.com.cn are consumer mail providers.
	if (labels.filter((label) => /^\d+$/.test(label)).length >= 2) return true
	const tld = labels[labels.length - 1] ?? ""
	// Trailing dot (`acmecorp.com.`) leaves an empty label — not evidence of a
	// package path, so fail toward redaction.
	if (tld === "") return false
	if (NON_TLD_SUFFIXES.has(tld)) return true
	// A TLD is at least two letters — ASCII or Unicode (`рф`, `メール`), or
	// punycode. The engine detects only ASCII addresses today, so the Unicode
	// branch is forward-looking: an engine upgrade must not turn a real IDN
	// address into a dropped detection.
	return !/^(?:xn--[a-z0-9]{2,}|\p{L}{2,})$/u.test(tld)
}

function isOperationalTag(tag: string): boolean {
	const lower = tag.toLowerCase()
	return lower === "" || /^\d+$/.test(lower) || OPERATIONAL_TAGS.has(lower)
}

/**
 * Role mailbox whose local part never identifies a person.
 *
 * A `+tag` is only ignored when the tag itself is operational: stripping every
 * tag would let `noreply+jane.doe@acmecorp.com` escape redaction entirely.
 */
export function isGenericLocalPart(local: string): boolean {
	const [base = local, ...tagParts] = local.split("+")
	if (!GENERIC_LOCAL_PARTS.has(base)) return false
	return tagParts.every(isOperationalTag)
}

/**
 * Whether an email detection identifies nobody: the harness itself, a package
 * path, or a role mailbox. Reserved test namespaces stay redacted on purpose.
 */
export function isNonIdentifyingEmail(span: string): boolean {
	if (isSelfIdentity(span)) return true
	const parts = splitAddress(span)
	// Unparseable: the engine flagged it as an address, so keep it redacted.
	if (!parts) return false
	if (isTechnicalEmailDomain(parts.domain)) return true
	return isGenericLocalPart(parts.local)
}

/**
 * Ranges that cannot identify a person or a reachable host: loopback,
 * link-local, "this network", benchmarking, and the documentation blocks
 * (IPv4 and IPv6). RFC1918 private space is NOT here — a private address
 * still describes real internal topology.
 */
export function isNonSensitiveIp(span: string): boolean {
	if (span === "::" || span === "::1") return true
	if (/^fe80:/i.test(span)) return true
	if (/^2001:db8:/i.test(span)) return true
	// Prefix-only v6 fragments that cannot start a real address: ClickHouse
	// scope markers (`DB::`), Go module versions (`core::0136::`), the bare ULA
	// network prefix (`fc00::`). Routable global unicast (2000::/3 → `2xxx::`,
	// `3xxx::`) and ULA /48 bases (`fdXX::`) are real topology — kept, same
	// precedent as RFC1918 above.
	if (/^[0-9a-f]{1,4}::$/i.test(span) && !/^[23][0-9a-f]{3}::$/i.test(span) && !/^fd[0-9a-f]{2}::$/i.test(span))
		return true
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(span)
	if (!v4) return false
	const [a, b] = [Number(v4[1]), Number(v4[2])]
	if (a === 0 || a === 127) return true
	if (a === 169 && b === 254) return true
	if (a === 192 && b === 0 && Number(v4[3]) === 2) return true
	// 198.51.100.0/24 (documentation) and 198.18.0.0/15 (benchmarking).
	if (a === 198 && ((b === 51 && Number(v4[3]) === 100) || b === 18 || b === 19)) return true
	if (a === 203 && b === 0 && Number(v4[3]) === 113) return true
	return false
}

/**
 * Single entry point for the precision filter: does this detection identify
 * nobody? Unknown entity types are never dropped (fail toward redaction).
 */
export function isNonIdentifyingDetection(entityType: string, span: string): boolean {
	if (entityType === "EMAIL_ADDRESS") return isNonIdentifyingEmail(span)
	if (entityType === "IP_ADDRESS") return isNonSensitiveIp(span)
	return false
}

/**
 * Secret entities whose vendor-prefix shape also occurs inside base64-encoded
 * binary payloads (embedded images, fonts). Measured on 2,604 engineering
 * transcripts: 0–3% precision — their prefix is not load-bearing inside a
 * base64 run. The entity still fires for real tokens in prose/JSON, where the
 * token is properly delimited.
 */
const BASE64_SHADOW_ENTITIES: ReadonlySet<string> = new Set([
	"FACEBOOK_TOKEN",
	"TWITTER_BEARER_TOKEN",
	"SQUARE_ACCESS_TOKEN",
	"ALIBABA_CLOUD_KEY",
	"GCP_API_KEY",
])

/**
 * Char sets for shadow evidence. START-side: the base64 alphabet, but NOT
 * `=` — the assignment byte (`KEY=<token>`) is the most common real-secret
 * framing and must never be treated as entropy (security-002). END-side:
 * only the blob terminator bytes `+`, `/`, `=` — engine value regexes are
 * greedy alnum tails, so an alphanumeric end-neighbor is truncation of a
 * real (over-long) key, not embedding; inside a blob the span's boundary is
 * always one of the three.
 */
function isBase64RunChar(c: string): boolean {
	if (c.length === 0 || c === "/") return false // URL path separator (correctness-003)
	return IS_BASE64_CHAR[c.charCodeAt(0)] === 1
}
function isBase64TailChar(c: string): boolean {
	return c === "+" || c === "/" || c === "="
}

/**
 * Whether a detection of a base64-shadow-prone entity sits inside an entropy
 * block: base64-alphabet characters on BOTH sides of the span. A real secret
 * is delimited (`token: EAAA…`, `"pat…",`); a payload noise segment never is
 * (`iVBORwEAAA…SUQmCC`). Both characters must be base64 or the detection is
 * kept — a single ambiguous neighbor fails toward redaction. Marker text
 * breaks the run (`[`/`]` are not base64), so fixture strings keep redacting.
 */
/**
 * How much base64 run precedes position `start`. `=` and `/` are excluded from
 * the alphabet here: the assignment byte and the URL separator are real-secret
 * delimiters, so they terminate the run (the doc previously said padding counts
 * — it does not, by design).
 * The engine-shadow predicate keys on immediate neighbors; keyword-anchored
 * custom patterns (GENERIC_SECRET) need a longer witness because their value
 * charset swallows base64 chars, so an end-neighbor never proves embedding.
 */
export function base64RunBefore(text: string, start: number): number {
	let n = 0
	for (let i = start - 1; i >= 0 && isBase64RunChar(text.charAt(i)); i--) {
		if (++n >= 16) return n // every caller compares >= 16 — constant-bound the walk (design-005)
	}
	return n
}

export function isBase64ShadowDrop(entityType: string, text: string, start: number, end: number): boolean {
	if (!BASE64_SHADOW_ENTITIES.has(entityType)) return false
	if (start <= 0 || end >= text.length) return false
	// Long-run witness: −16 base64 chars before the span can only be payload — drop
	// regardless of the end neighbor. Genuine framings (api_key=AIza…, URL-path
	// segments, 'token: pat…') all expose a non-base64 delimiter on the left
	// ('=', '/', ':', quote, space), so the run there is 0 (rule-2 assessment:
	// double-'=' evidence was measured rule-less on corpus — the FP spans sit
	// mid-run with alnum neighbors on both sides).
	if (base64RunBefore(text, start) >= 16) return true
	return isBase64RunChar(text.charAt(start - 1)) && isBase64TailChar(text.charAt(end))
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
 * excluded entities, drop detections that identify nobody, then greedily
 * resolve overlaps.
 *
 * Precision filtering happens BEFORE overlap resolution: a rejected span must
 * not consume coverage and suppress a neighbouring detection that is real.
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
			// Attribution correction (correctness-001): the engine claims
			// realistic-length sk-ant- keys as OPENAI_KEY long before the
			// custom-anchored ANTHROPIC_KEY pattern gets a turn. Real Anthropic
			// keys are ~100+ chars, well over the engine's OPENAI threshold,
			// so without this relabel the label fix below is a no-op for real
			// keys. Fire only on the distinct prefix — never on content alone.
			const entityType = d.entityType === "OPENAI_KEY" && d.text.startsWith("sk-ant-") ? "ANTHROPIC_KEY" : d.entityType
			// Exclusion check uses the corrected label (correctness-007).
			if (excluded.has(entityType)) continue
			if (isNonIdentifyingDetection(entityType, d.text)) continue
			if (isBase64ShadowDrop(entityType, text, d.start, d.end)) continue
			active.push({ entityType, start: d.start, end: d.end, text: d.text })
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
 * Token-mode counterpart of {@link composeRedactedText}: identifier-class
 * detections (TOKENIZED_ENTITIES) are spliced as stable per-session tokens
 * recorded in `vault`; every other detection keeps its marker — secret
 * classes stay marker-shaped in every mode (a vault of live credentials is
 * strictly more dangerous than a vault of identities). Same right-to-left
 * splice; the vault's token map is the ONLY place the token→original
 * mapping exists.
 */
export function composeTokenizedText(text: string, kept: EngineDetection[], vault: TokenVault): string {
	let out = text
	for (const d of [...kept].sort((a, b) => b.start - a.start)) {
		const replacement = TOKENIZED_ENTITIES.has(d.entityType)
			? tokenFor(vault, d.entityType, text.slice(d.start, d.end))
			: `[REDACTED-${d.entityType}]`
		out = `${out.slice(0, d.start)}${replacement}${out.slice(d.end)}`
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

/** Token-mode variant of {@link detectAndCompose} — used by the session hooks. */
export async function detectAndComposeTokenized(
	text: string,
	engine: GuardrailsEngine,
	excluded: ReadonlySet<string>,
	vault: TokenVault,
): Promise<string> {
	return composeTokenizedText(text, await collectDetections(text, engine, excluded), vault)
}

// ---------------------------------------------------------------------------
// Custom redaction patterns not covered by @bulkhead-ai/core
// ---------------------------------------------------------------------------

/**
 * secretGroup semantics shared with user-defined entities
 * (policy.ts `RedactionPattern`): when set, only this capture group is
 * replaced by the marker; the rest of the match (the anchoring context)
 * survives. Group 1 is the anchor, group 2 the secret. Bare patterns (no
 * secretGroup) replace the whole match, which is correct for prefixed
 * shapes.
 */
/**
 * `skipIfEmbeddedInBase64`: anchored keyword shapes also occur inside base64
 * payloads, where the keyword appears mid-blob. When the flag is set, matches
 * immediately preceded by a >=16-char base64 run are skipped — the engine's
 * base64-shadow drop covers engine detections only, and the keyword would
 * otherwise re-capture the span the drop removed.
 */
type CustomPattern = RedactionPattern & {
	skipIfEmbeddedInBase64?: boolean
	/** Value guard: when true, the match is left untouched (matches stay eligible for other patterns' spans via separate matches). */
	rejectValue?: (value: string) => boolean
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
	// Anthropic keys first — the generic sk- catch-all below would otherwise
	// claim sk-ant- spans under the wrong label (matters for vault tokens and
	// telemetry attribution). First pattern wins the span.
	{ name: "ANTHROPIC_KEY", regex: /\bsk-ant-[A-Za-z0-9_-]{6,}\b/g },
	// OpenAI-style API keys (sk-, sk-proj-, sk-conv-) — the bulkhead
	// secret engine's key guard misses the newer prefixed formats (verified:
	// sk-proj-… passes through untouched, and exported such a key once).
	// Generic on purpose (unknown-future sk- formats), but sk-ant- is owned by
	// the ANTHROPIC_KEY pattern above.
	{ name: "OPENAI_API_KEY", regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{10,}\b/g },
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
	// Azure connection-string secrets (SharedAccessKey/SharedAccessSignature).
	// AccountName is an identifier and the keyword itself is never secret, so
	// only the value is redacted — mirrored after the engine's keyword-anchored
	// patterns, kept value-only for span-minimal consistency with the URL
	// customs. AccountKey is deliberately NOT anchored here: AZURE_STORAGE_KEY
	// below owns it, so the pre-existing excludedEntities key for AccountKey
	// redaction keeps working (narrowed per correctness-002 — this pattern used
	// to claim AccountKey too, shadowing the storage-key pattern entirely).
	{
		name: "AZURE_CONNECTION_STRING",
		regex: /((?:SharedAccessKey|SharedAccessSignature)=)([A-Za-z0-9+/=]{20,})/g,
		secretGroup: 2,
	},
	// Azure storage keys inside a connection string. The value floor matches
	// the fail-open truncation principle the AWS custom documents: a truncated
	// (20-39 char) AccountKey must still redact — pre-narrowing, the
	// connection-string pattern covered those at {20,}.
	{
		name: "AZURE_STORAGE_KEY",
		regex: /(AccountKey=)([A-Za-z0-9+/]{20,}={0,2})/g,
		secretGroup: 2,
	},
	// Basic-auth header values.
	{
		name: "BASIC_AUTH",
		regex: /(Authorization:\s*Basic\s+)([A-Za-z0-9+/=]{8,})/gi,
		secretGroup: 2,
	},
	// Credential-bearing database URIs. The scheme is the anchor; the userinfo
	// (`user:password`, or password-only for redis) is the only secret in the
	// string, so only that span is replaced. A credentialless DSN
	// (`postgres://host/db`) carries no secret and must pass through; the
	// engine's bare DATABASE_CONNECTION_STRING scheme shape stays excluded for
	// exactly that reason.
	{
		name: "DATABASE_CONNECTION_STRING",
		regex: /(\b(?:postgres(?:ql)?|mysql|mongodb|redis|amqp|mssql):\/\/)([^/\s:@]*:[^@\s/]+)(@[^\s/"']*)/gi,
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
			/([?&;](?:token|api_?key|key|sig|signature|secret|password|access_token|refresh_token|session_token|client_secret|sas|sharedaccesssignature)=)([^&;\s[]{8,})/gi,
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
	// Supabase secret keys only. The engine detector fires on
	// SUPABASE_ANON_KEY too — public-by-design browser keys — so it stays
	// excluded and this keyword-anchored custom carries the coverage:
	// SUPABASE_KEY / SUPABASE_SERVICE_KEY assignments (eyJ… 100+ JWT), never
	// the anon key.
	{
		name: "SUPABASE_KEY",
		regex: /((?:supabase(?:_service)?_key)\s*[:=]\s*["']?)(eyJ[A-Za-z0-9_-]{100,})/gi,
		secretGroup: 2,
	},
	// Keyword-anchored free-text secrets: `password: …`, `secret = …`,
	// `token: …`, `credential: …`. Restores the engine's GENERIC_SECRET
	// coverage (anchor_required, excluded by default) for the free-text case
	// the JSON sensitive-key path cannot see. Value charset excludes `[` so
	// an earlier pattern's `[REDACTED-…]` marker is never re-consumed.
	// The anchor consumes a leading non-alphanumeric byte: without it the
	// keyword matches keyword-shaped suffixes of camelCase identifiers
	// (`oauthAccessToken = "kimchi-e2e-…"` → "Token = …" — measured ~2,850
	// false redactions across engineering transcripts). `_` / `-` stay legal
	// boundaries: MY_TOKEN=… env keys and --token=… CLI flags are real
	// secret habitats, not identifiers.
	{
		skipIfEmbeddedInBase64: true,
		rejectValue: isGenericNonSecretValue,
		name: "GENERIC_SECRET",
		regex:
			/((?:^|[^A-Za-z0-9])(?:api[_-]?|access[_-]?)?(?:secret|password|passwd|token|credential|credentials)\s*[:=]\s*["']?)([^\s"'[]{16,})/gi,
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
 * Value guards for GENERIC_SECRET (rule-1, amended by two external reviewers
 * against the measured corpus): the keyword anchor still fires on values that
 * are provably not secrets — shell expansions (${VAR:-…}, $(cmd), $VAR/…),
 * doc placeholders (<your_access_token>), absolute/relative or variable-anchored
 * paths, and digit-free identifier shapes (oauthRefreshToken, options.bearerToken).
 * Bounds: base64 secrets containing '/' start alphanumeric, never path-anchored;
 * diceware passphrases carry no digits but are not identifier-shaped — only
 * camelCase-or-dotted digit-free values are rejected, so word-like secrets with
 * an uppercase letter and no symbols DO get rejected intentionally (the corpus
 * found none), while `mysecretpassword` lowercase forms stay redacted.
 */
export function isGenericNonSecretValue(value: string): boolean {
	// `$`-leading shell expansions and command substitutions only:
	// ${VAR}, $[idx], $(cmd), $VAR — the previous /\$/\w clause rejected any
	// word-char after `$`, which let bcrypt/argon2 hashes ($2b$12$…) and
	// $-prefixed secrets through (correctness-005).
	if (/^\$(?:[{([]|[A-Za-z_])/.test(value) || /^<[A-Za-z0-9_\s-]*>$/.test(value)) return true
	// Paths: anchored start (/, ~/, ./, ../, $VAR/) with path-ish body.
	if (/^(?:~?\/|\.\.?\/|\$[A-Za-z_][\w]*\/)[\w.+=/@-]+\/?$/.test(value)) return true
	// Identifier-shaped, digit-free (camelCase single words or dotted paths) —
	// every measured identifier-FP is digit-free while real secrets carry digits.
	if (!/\d/.test(value) && /^[A-Za-z$_][\w$]*(?:\.[\w$]+)*[,;]?$/.test(value) && /[A-Z]/.test(value)) return true
	return false
}

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
 * Patterns whose name is in the disabled set are skipped — the resolved
 * policy's disabledEntities governs kimchi-owned markers (e.g. LOCAL_PATH):
 * an entity/category OFF, or the legacy excludedEntities list. Registry
 * defaults never filter customs: they exclude anchor-required entities at
 * the ENGINE so their anchored re-additions here can fire (see config.ts /
 * entity-tiers.ts).
 *
 * User-defined patterns (from redaction.customEntities) run after the
 * built-ins — the snapshot passes the joined array via `patterns`. A user
 * pattern can match an earlier marker's text — the same caveat the built-in
 * GENERIC_SECRET documents; user regexes are the operator's responsibility.
 */
export function applyCustomPatterns(
	text: string,
	disabled: ReadonlySet<string>,
	onMatch?: (match: { name: string; secret: string }) => void,
	patterns?: readonly RedactionPattern[],
): string {
	let result = text
	const all: readonly CustomPattern[] = patterns ?? CUSTOM_PATTERNS
	for (const pattern of all) {
		const { name, regex, secretGroup } = pattern
		if (disabled.has(name)) continue
		const marker = `[REDACTED-${name}]`
		result = result.replace(regex, (match: string, ...args: unknown[]) => {
			if (pattern.skipIfEmbeddedInBase64) {
				const offset = args[args.length - 2]
				const input = args[args.length - 1]
				// The anchored match starts AT its consumed boundary byte, so the
				// byte class decides: only payload-internal bytes keep the run
				// alive — `+`/`/` (raw base64) and `-`/`_` (base64url/JWT, and the
				// keyword suffixes of anchored names like FACEBOOK_TOKEN). Every
				// other delimiter (space, quote, `=`, `:`, `;`, `,`, tab, newline)
				// is real secret framing and must redact — the measured across-
				// the-delimiter run let any 16+ alnum token before a keyword
				// suppress the adjacent true secret (severe security-001 /
				// correctness-001 / design-p03). Residual accepted tradeoff,
				// mirroring the engine witness: a ≥16-base64-char run glued to
				// `+`/`/`/`-`/`_` still reads as payload.
				if (typeof offset === "number" && typeof input === "string") {
					const boundary = input.charAt(offset)
					const payloadInternal = boundary === "+" || boundary === "/" || boundary === "-" || boundary === "_"
					const run = base64RunBefore(input, offset) + (isBase64RunChar(boundary) ? 1 : 0)
					if (payloadInternal && run >= 16) return match
				}
			}
			if (secretGroup !== undefined) {
				// Replace by POSITION, never by substring search: the secret's text
				// can also occur inside the anchor (user == password URLs, keyword
				// prefixes containing the secret), and a substring replace would
				// marker the anchor and leak the secret. The anchored patterns all
				// cover their match with capture groups, so splice from the groups
				// the callback hands us (offset + input trail the rest args).
				const groups = args.slice(0, -2)
				const secret = groups[secretGroup - 1]
				// A rejected value leaves the match untouched — never fall into the
				// tail marker (that would still redact; and it would claim the span
				// for later patterns that run single-shot passes).
				if (pattern.rejectValue && typeof secret === "string" && pattern.rejectValue(secret)) return match
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
 * Bearer tokens, OAuth tokens) as a second pass. Fail-open behavior lives in
 * `redactTextCounted`; this function propagates scan failures.
 */
async function redactTextWithSnapshot(text: string, snapshot: EngineSnapshot, vault?: TokenVault): Promise<string> {
	// Token composition only engages when BOTH the snapshot says token mode
	// and a session vault exists. A missing vault (unknown/restarted
	// session, non-hook callers) falls back to markers — markers decay
	// gracefully in every downstream surface; a token without its vault
	// renders as dead text.
	const afterEngine =
		snapshot.renderMode === "tokens" && vault
			? await detectAndComposeTokenized(text, snapshot.engine, snapshot.exclusions, vault)
			: await detectAndCompose(text, snapshot.engine, snapshot.exclusions)
	return applyCustomPatterns(afterEngine, snapshot.disabled, undefined, snapshot.patterns)
}

export async function redactTextOrThrow(text: string): Promise<string> {
	return redactTextWithSnapshot(text, resolveSnapshot())
}

/**
 * Upper bound on a single engine scan before the fail-open path engages.
 * The scan normally completes in milliseconds (wasm in-process); this bound
 * exists to guarantee `redactTextCounted` always *settles* — the pii-redaction
 * hooks' in-flight map keys its strong references on the promise's
 * resolution, so a scan that never resolved would pin a message object for
 * the process lifetime. The underlying engine promise cannot be cancelled,
 * so a truly stuck scan still runs in the background; the bound is about
 * settling the caller-visible promise, not freeing the engine.
 */
const SCAN_SETTLE_TIMEOUT_MS = 30_000

function settleBoundScan(run: () => Promise<string>): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`PII redaction scan did not settle within ${SCAN_SETTLE_TIMEOUT_MS}ms; failing open`)),
			SCAN_SETTLE_TIMEOUT_MS,
		)
	})
	return Promise.race([run(), timeout]).finally(() => clearTimeout(timer))
}

/**
 * Shared fail-open core behind `redactText` and the measured variant: scan,
 * and on engine failure return the original text unchanged. `onFailure` is
 * called with the thrown error so callers can count failures; whether (and
 * how often) to log is the caller's decision — the measured variant logs
 * once per invocation, not once per string, so a degraded engine cannot
 * flood stderr with a stack trace per scanned string in a large context.
 */
async function redactTextCounted(
	text: string,
	onFailure?: (err: unknown) => void,
	snapshot?: EngineSnapshot,
	vault?: TokenVault,
): Promise<string> {
	try {
		// A caller-supplied snapshot carries the pass's atomic policy view;
		// otherwise resolve the current one.
		return await settleBoundScan(() => redactTextWithSnapshot(text, snapshot ?? resolveSnapshot(), vault))
	} catch (err) {
		onFailure?.(err)
		return text
	}
}

export async function redactText(text: string): Promise<string> {
	return redactTextCounted(text, (err) => console.error("PII redaction scan failed, returning original text:", err))
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const IS_BASE64_CHAR = new Uint8Array(128)
for (let i = 0; i < BASE64_ALPHABET.length; i++) IS_BASE64_CHAR[BASE64_ALPHABET.charCodeAt(i)] = 1
const LINE_FEED = "\n".charCodeAt(0)
const CARRIAGE_RETURN = "\r".charCodeAt(0)
const PADDING = "=".charCodeAt(0)

/**
 * Whether `text` from `start` on is well-formed padded base64; line breaks are
 * ignored. A char loop rather than a regex: image payloads run to many MB.
 */
function isBase64From(text: string, start: number): boolean {
	let chars = 0
	let padding = 0
	for (let i = start; i < text.length; i++) {
		const c = text.charCodeAt(i)
		if (c === LINE_FEED || c === CARRIAGE_RETURN) continue
		if (c === PADDING) {
			if (++padding > 2) return false
			continue
		}
		if (padding > 0 || IS_BASE64_CHAR[c] !== 1) return false
		chars++
	}
	return chars > 0 && (chars + padding) % 4 === 0
}

/** Base64 chars needed to decode the 12 bytes the image signatures below inspect. */
const IMAGE_SIGNATURE_BASE64_CHARS = 16

/**
 * Whether base64 at `start` decodes to a PNG, JPEG, GIF or WebP signature —
 * deliberately just those four: the formats vision providers accept. Other
 * image/* subtypes keep being scanned (fail-closed), never reaching a
 * provider as images anyway.
 */
function hasImageSignature(text: string, start: number): boolean {
	// Line breaks are legal base64: collect signature chars past them, else a
	// break inside the window shrinks it and WebP's 12-byte check falls short.
	let head = ""
	for (let i = start; i < text.length && head.length < IMAGE_SIGNATURE_BASE64_CHARS; i++) {
		const c = text.charCodeAt(i)
		if (c !== LINE_FEED && c !== CARRIAGE_RETURN) head += text[i]
	}
	const decoded = Buffer.from(head, "base64").toString("latin1")
	return (
		decoded.startsWith("\x89PNG\r\n\x1a\n") ||
		decoded.startsWith("\xff\xd8\xff") ||
		decoded.startsWith("GIF8") ||
		(decoded.startsWith("RIFF") && decoded.slice(8, 12) === "WEBP")
	)
}

function isImageBase64From(text: string, start: number): boolean {
	return hasImageSignature(text, start) && isBase64From(text, start)
}

const IMAGE_DATA_URL_PREFIX = /^data:image\/[a-z0-9.+-]+(?:;[^;,]*)*;base64,/i
const IMAGE_URL_KEYS: ReadonlySet<PropertyKey> = new Set(["image_url", "imageUrl"])

/** A complete image data URL in `image_url`/`imageUrl`, or the `url` nested inside one. */
function isImageDataUrlField(key: PropertyKey, value: string, parentKey: PropertyKey | undefined): boolean {
	if (!IMAGE_URL_KEYS.has(key) && !(key === "url" && parentKey !== undefined && IMAGE_URL_KEYS.has(parentKey))) {
		return false
	}
	// The ^ anchor keeps the regex cheap on huge non-URL strings; a match ends
	// at the first comma, which base64 cannot contain.
	const prefix = IMAGE_DATA_URL_PREFIX.exec(value)
	return prefix !== null && isImageBase64From(value, prefix[0].length)
}

/** The base64 `data` of an image block: internal/Google `mimeType`, Anthropic `media_type`. */
function isImageBlockData(key: PropertyKey, value: string, block: Record<PropertyKey, unknown>): boolean {
	if (key !== "data") return false
	const mime = block.mimeType ?? block.media_type
	return typeof mime === "string" && mime.toLowerCase().startsWith("image/") && isImageBase64From(value, 0)
}

/**
 * Deep-walk any JSON-serializable structure and redact all string values.
 *
 * Shared walker for the lenient and strict public variants — identical
 * semantics: every string walked, trace-ID keys passed through unchanged,
 * sensitive-key string values force-redacted, enumerable symbols preserved.
 * Only the per-string redaction function differs (fail-open vs fail-closed).
 *
 * Binary image payloads are the one exception: a secret-shaped run in them is
 * coincidence, and splicing a marker in corrupts the image. Base64 is exempt
 * only in image fields, when well-formed and carrying a real image signature;
 * typed arrays (Bedrock's bytes) hold no strings and pass through intact.
 * Bytes after the signature are trusted wholesale — plaintext EXIF/tEXt
 * metadata and anything smuggled past the prefix flow through unredacted —
 * because scanning inside would corrupt the very payload it means to protect.
 */
async function redactObjectStringsWith<T>(
	obj: T,
	redactString: (text: string) => Promise<string>,
	snapshot: EngineSnapshot,
	onScannedPair?: (input: string, output: string) => void,
	parentKey?: PropertyKey,
): Promise<T> {
	if (typeof obj === "string") {
		const out = await redactString(obj)
		onScannedPair?.(obj, out)
		return out as T
	}
	if (ArrayBuffer.isView(obj)) return obj
	if (Array.isArray(obj)) {
		return Promise.all(
			obj.map((item) => redactObjectStringsWith(item, redactString, snapshot, onScannedPair, parentKey)),
		) as Promise<T>
	}
	if (obj !== null && typeof obj === "object") {
		// The snapshot was resolved once at the pass entry — the sensitive-key
		// policy below is the same atomic view the string scans use, even if a
		// concurrent settings edit rebuilds the engine mid-walk.
		const secretFieldRedacts = !snapshot.disabled.has("SECRET_FIELD")
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
				if (
					typeof value === "string" &&
					(isImageBlockData(key, value, source) || isImageDataUrlField(key, value, parentKey))
				) {
					return Promise.resolve(value)
				}
				// Redact any string value stored under a sensitive key name.
				if (secretFieldRedacts && typeof key === "string" && typeof value === "string" && isSensitiveKey(key)) {
					onScannedPair?.(value, "[REDACTED-SECRET_FIELD]")
					return Promise.resolve("[REDACTED-SECRET_FIELD]")
				}
				return redactObjectStringsWith(value, redactString, snapshot, onScannedPair, key)
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

/**
 * Marker and token shapes a redaction pass can produce: `[REDACTED-<ENTITY>]`
 * and (token mode) `[<ENTITY>_N]`. The entity group is lazily captured with
 * an optional trailing counter so both shapes tally under the same entity
 * key — marker and token modes produce identical tallies for identical
 * input. A composite token like `[EMAIL_ADDRESS_12]` groups as
 * EMAIL_ADDRESS (lazy growth stops at the first `]`-terminated suffix), not
 * `EMAIL_ADDRESS_1`.
 */
const REDACTION_SHAPE_RE = /\[(?:REDACTED-)?([A-Z0-9_]+?)(?:_\d+)?\]/g

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
	const outMarkers = [...output.matchAll(REDACTION_SHAPE_RE)]
	if (outMarkers.length === 0) return
	const available = new Map<string, number>()
	for (const match of input.matchAll(REDACTION_SHAPE_RE)) {
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
	/**
	 * Category attribution for the tallied entities (entity → category key,
	 * e.g. EMAIL_ADDRESS → "emails"), resolved from the pass's policy view.
	 *
	 */
	categories: Record<string, string>
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
/**
 * @param vault  Optional session token vault. When the resolved policy is
 *   token mode and a vault is supplied, identifier detections render as
 *   `[<ENTITY>_N]` tokens recorded in the vault (presentation-side
 *   retrieval). Omitted by exports and non-hook callers → markers always.
 */
export async function redactObjectStringsMeasured<T>(obj: T, vault?: TokenVault): Promise<RedactionMeasurement<T>> {
	const report: RedactionReport = { entities: {}, categories: {}, stringsScanned: 0, engineFailures: 0 }
	let failureLogged = false
	// One snapshot per measured pass — the SECRET_FIELD gate in the walker and
	// every settle-bounded string scan see the same atomic policy view.
	const snapshot = resolveSnapshot()
	const redactStringMeasured = async (text: string): Promise<string> => {
		if (text.length === 0) return text
		report.stringsScanned += 1
		return redactTextCounted(
			text,
			(err) => {
				report.engineFailures += 1

				// One log per invocation: a persistently degraded engine would
				// otherwise print a stack trace per scanned string per hook.
				if (!failureLogged) {
					failureLogged = true
					console.error("PII redaction scan failed, returning original text:", err)
				}
				return text
			},
			snapshot,
			vault,
		)
	}
	const redacted = await redactObjectStringsWith(obj, redactStringMeasured, snapshot, (input, output) =>
		tallyMarkersNet(input, output, report.entities),
	)
	// Attribute the tallied entities to categories from this pass's policy
	// view, so the emitted facts can be grouped by the same unit admins
	// toggle. A marker typesafe-unknown to the pass's map reports "custom".
	for (const entity of Object.keys(report.entities)) {
		report.categories[entity] = snapshot.categories.get(entity) ?? "custom"
	}
	return { redacted, report }
}

/** An empty report — the starting point for cross-invocation aggregation. */
export function emptyRedactionReport(): RedactionReport {
	return { entities: {}, categories: {}, stringsScanned: 0, engineFailures: 0 }
}

/** Merge `source` into `target` in place (both shaped as {@link RedactionReport}). */
export function mergeReports(target: RedactionReport, source: RedactionReport): void {
	target.stringsScanned += source.stringsScanned
	target.engineFailures += source.engineFailures
	for (const [entity, count] of Object.entries(source.entities)) {
		target.entities[entity] = (target.entities[entity] ?? 0) + count
	}
	for (const [entity, category] of Object.entries(source.categories)) {
		// First attribution wins within one invocation (content before details).
		// A custom entity whose category the operator redefines mid-session may
		// attribute its tail to the earlier category — telemetry-only ambiguity.
		target.categories[entity] ??= category
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
 * Reversible tokens already stored in the export input (token mode keeps
 * session files tokenized) are converted to markers with `tokensToMarkers`:
 * an export contains no recoverable form of any original. That conversion
 * is vault-independent and lossy — the right shape for data leaving the
 * machine.
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
	return redactObjectStringsWith(
		obj,
		async (text) => tokensToMarkers(await redactTextWithSnapshot(text, snapshot)),
		snapshot,
	)
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
