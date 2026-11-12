/**
 * Reversible-redaction token vault.
 *
 * In token mode (`redaction.renderMode: "tokens"`, see config.ts), engine
 * detections for identifier entities are rendered as stable per-session
 * tokens — `[EMAIL_ADDRESS_1]`, `[IP_ADDRESS_2]` — instead of
 * `[REDACTED-EMAIL_ADDRESS]` markers. The vault is the ONLY place the
 * token→original mapping lives, and it is deliberately in-memory and
 * session-keyed:
 *
 * - never written to session files, exports, telemetry, or logs
 * - after a restart, stored tokens render verbatim (degraded, not wrong —
 *   an unknown token is never substituted)
 * - secret-class detections and every custom pattern stay marker-shaped in
 *   every mode: a vault holding live credentials is strictly more dangerous
 *   than a vault holding identities, and cross-mention coherence gains for
 *   secrets are ~zero
 *
 * Stability is per VALUE, not per occurrence: two mentions of
 * `jane.doe@acme.com` both render as the same token, which is the entire
 * coherence win — the model can tell those mentions are the same address,
 * and that `[EMAIL_ADDRESS_2]` is a different one. The privacy price is
 * linkability: the transcript reveals occurrence structure (how many
 * distinct values and how often each appears) that markers conceal.
 *
 * Counters are PROCESS-global (`tokenCounters`), deliberately not
 * per-vault. The ACP server hosts concurrent sessions in one process and a
 * subagent's redacted text can land in a parent transcript; two vaults
 * issuing `[EMAIL_ADDRESS_1]` for different values would make a
 * wrong-session substitution look real. With one allocator per process a
 * foreign token is unknown to every other vault by construction: worst
 * case it renders verbatim, never a wrong value.
 *
 * Lifecycle lives in installVaultLifecycle below: a vault per session id
 * (session_start / session_shutdown, mirroring tags.ts), plus a
 * paint-time pointer the TUI markdown transformer consults — the
 * transformer API receives no session identity, and the TUI paints
 * exactly one session at a time. ACP never uses the pointer: the ACP
 * server looks vaults up by session id directly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Engine entity classes that get tokens in token mode — identifiers where
 * cross-mention coherence matters. Everything else (secret-class engine
 * detections, all custom patterns) stays marker-shaped in every mode.
 */
export const TOKENIZED_ENTITIES: ReadonlySet<string> = new Set([
	"EMAIL_ADDRESS",
	"IP_ADDRESS",
	"PHONE_NUMBER",
	"PERSON",
	"URL",
])

/** One session's bidirectional token map. Maps grow monotonically. */
export interface TokenVault {
	/** `entityType + U+0001 + originalSpan` → token. */
	readonly toToken: Map<string, string>
	/** token → original span. */
	readonly fromToken: Map<string, string>
}

export function createTokenVault(): TokenVault {
	return { toToken: new Map(), fromToken: new Map() }
}

/** Process-global token counters — one allocator per process (header). */
const tokenCounters = new Map<string, number>()

/**
 * Allocate (or recall) the token for one detection. Same (entityType,
 * value) → same token for the vault's lifetime; distinct values → distinct
 * tokens even within one entity type.
 */
export function tokenFor(vault: TokenVault, entityType: string, value: string): string {
	// The key is `entityType + U+0001 + value` — a separator, not bare
	// concatenation, so value shapes can never collide into a foreign
	// entity's namespace.
	const key = `${entityType}\u0001${value}`
	const existing = vault.toToken.get(key)
	if (existing !== undefined) return existing
	const n = (tokenCounters.get(entityType) ?? 0) + 1
	tokenCounters.set(entityType, n)
	const token = `[${entityType}_${n}]`
	vault.toToken.set(key, token)
	vault.fromToken.set(token, value)
	return token
}

/**
 * Token shape emitted by {@link tokenFor}: an all-caps identifier entity
 * name, an underscore, a decimal counter. Markers (`[REDACTED-…]`) cannot
 * match — the hyphen is outside the character class. 42 chars bounds the
 * scan: every engine entity name is far shorter.
 */
const TOKEN_RE = /\[([A-Z][A-Z0-9_]{0,40}_\d+)\]/g

/**
 * Seed scan: same shape as TOKEN_RE with the suffix kept separately so the
 * entity name can be recovered without knowing where the entity name ends
 * (underscore split from the RIGHT).
 */
const SEED_RE = /\[([A-Z][A-Z0-9_]{0,40})_(\d+)\]/g
// Cap accepted seed suffixes: counters are plain JS numbers, and at
// 2**53 the next increment rounds back to the same value — two distinct
// entities would then collide on one token (the second overwriting the
// first vault mapping) and substitution would render the wrong original.
// Over-seeding is harmless, and counters are PROCESS-global (a long-lived
// ACP process legitimately accumulates very large suffixes over time), so
// the cap must not reject large REAL values — it only excludes the crafted
// precision-collision band near 2**53, like `[EMAIL_ADDRESS_9007199254740991]`.
const SEED_SUFFIX_CAP = 0xffffffff

/**
 * Raise the process-wide counters above every token suffix observed in
 * `texts`. Called when a fresh vault comes up over previously persisted
 * content (session resume, in-process vault loss): without it, counters
 * restart at 1 and the new vault re-issues a token already stored for a
 * DIFFERENT value — the transcript would then substitute a wrong
 * original over old occurrences. Over-seeding is harmless (tokens stay
 * unique); under-seeding is a wrong-value substitution.
 *
 * Returns the observed per-entity maxima so the caller can log them —
 * seeding is the resume-safety backbone, and it should be visible when it
 * ran and what it found.
 */
function seedOneText(text: string, observed: Map<string, number>): void {
	SEED_RE.lastIndex = 0
	let match = SEED_RE.exec(text)
	while (match !== null) {
		const entity = match[1]
		const suffix = Number.parseInt(match[2], 10)
		if (entity !== undefined && Number.isSafeInteger(suffix) && suffix > 0 && suffix <= SEED_SUFFIX_CAP) {
			if ((observed.get(entity) ?? 0) < suffix) observed.set(entity, suffix)
			if ((tokenCounters.get(entity) ?? 0) < suffix) tokenCounters.set(entity, suffix)
		}
		match = SEED_RE.exec(text)
	}
}

export function seedTokenCountersFromTexts(texts: Iterable<string>): Map<string, number> {
	const observed = new Map<string, number>()
	for (const text of texts) seedOneText(text, observed)
	return observed
}

/**
 * Chunked async seed: the regex sweep over a large persisted transcript is
 * the one potentially long synchronous block per session start — in a
 * multi-session ACP process it would stall every other session's stream.
 * Yields to the event loop periodically. Safe to await mid-sweep: counters
 * only ever RISE, so concurrent allocations stay unique either way.
 */
const SEED_CHUNK_STRINGS = 2000

async function seedTokenCountersChunked(texts: Iterable<string>): Promise<Map<string, number>> {
	const observed = new Map<string, number>()
	let sinceYield = 0
	for (const text of texts) {
		seedOneText(text, observed)
		if (++sinceYield >= SEED_CHUNK_STRINGS) {
			sinceYield = 0
			await new Promise((resolve) => setImmediate(resolve))
		}
	}
	return observed
}

/**
 * Yield every string reachable inside `value`. Session entries are JSON
 * parsed — acyclic by construction — so no cycle guard is needed; the
 * depth cap is generous (24) to catch tokens nested in tool-call input
 * objects while still bounding adversarial input.
 */
export function* deepStrings(value: unknown, depth = 0): Generator<string> {
	if (depth > 24 || value === null || value === undefined) return
	if (typeof value === "string") {
		yield value
		return
	}
	if (Array.isArray(value)) {
		for (const item of value) yield* deepStrings(item, depth + 1)
		return
	}
	if (typeof value === "object") {
		for (const item of Object.values(value)) yield* deepStrings(item, depth + 1)
	}
}

/**
 * Token → marker shape: `[EMAIL_ADDRESS_12]` → `[REDACTED-EMAIL_ADDRESS]`.
 * Same split-from-the-right glyph run as SEED_RE, so every token this file
 * can issue or seed from converts. Suffix digits are dropped wholesale.
 */
const TOKEN_TO_MARKER_RE = /\[([A-Z][A-Z0-9_]{0,40})_\d+\]/g

/**
 * Convert every token-shaped span in `text` to its marker equivalent,
 * vault-independent and lossy (the value is gone). For the strict export
 * walk: stored session entries are tokenized and exports must reveal
 * nothing — not even the vault-resolvable original — so exports are the
 * ONE surface where tokens degrade forward into irreversible markers.
 */
export function tokensToMarkers(text: string): string {
	return text.replace(TOKEN_TO_MARKER_RE, (_span, entity: string) => `[REDACTED-${entity}]`)
}

/**
 * Replace every vault-known token in `text` with its original value.
 * Unknown tokens (never allocated, foreign-session, or allocated in a
 * vault that no longer exists) pass through VERBATIM: substitution must
 * never crash and never invent a value.
 *
 * Full-text and stateless — safe to call on every TUI repaint of a growing
 * text block: a token split across the current tail either lacks its
 * closing `]` (no match) or resolves in a later paint once complete.
 */
export function substituteTokens(vault: TokenVault, text: string): string {
	if (!text.includes("[")) return text
	return text.replace(TOKEN_RE, (token) => vault.fromToken.get(token) ?? token)
}

/**
 * Deep display substitution: rebuild `value` with every nested string
 * substituted (arrays recursed, plain objects rebuilt key-for-key; every
 * other value — numbers, null, class instances like Date — returned as-is,
 * since rebuilding them would drop their prototype). For display-only
 * surfaces whose token-bearing strings sit inside JSON argument/result
 * objects (ACP rawInput/rawOutput). Plain objects are rebuilt rather
 * than mutated: the in-memory tool args are shared with execution, and
 * the executed payload must keep its tokens.
 */
export function substituteTokensDeep(vault: TokenVault, value: unknown): unknown {
	if (typeof value === "string") return substituteTokens(vault, value)
	if (Array.isArray(value)) return value.map((item) => substituteTokensDeep(vault, item))
	if (value !== null && typeof value === "object") {
		const proto = Object.getPrototypeOf(value)
		if (proto !== Object.prototype && proto !== null) return value
		const out: Record<string, unknown> = {}
		for (const [key, entry] of Object.entries(value)) out[key] = substituteTokensDeep(vault, entry)
		return out
	}
	return value
}

// ---------------------------------------------------------------------------
// Execution-side dereference (the mirrored half of display substitution).
//
// The industry-standard agent-harness shape (Cover, Shadow, PrivAiTe, Veil,
// privacy-proxy): restore is the CORRECTNESS path — local file-mutation
// tools execute with the user's real values, over already-complete args,
// while the model's context, session files, and unknown/networked tools
// keep placeholders. Only the tools in EXEC_DEREF_TOOLS ever receive
// originals (allowlist + passthrough default): bash, MCP, agents and any
// other tool keep their tokenized args, so no deref path can route an
// original into outbound traffic. The transient execution copy is the only
// destination: stored args stay tokenized (the did-surface tests pin it).
// ---------------------------------------------------------------------------

/**
 * File-mutation tools whose execute passes args through vault dereference.
 * Execution and display BOTH consult this one constant: a surface mirrors
 * what execution will do, card for card.
 */
export const EXEC_DEREF_TOOLS: ReadonlySet<string> = new Set(["edit", "write"])
// NOTE: apply_patch is intentionally NOT in the allowlist — there is no
// tool-registration seam for it in this codebase (only renderers for the
// tool name), so its execute is unreachable; including it would make the
// display claim about execution untrue. Join when a seam exists.

/**
 * Return `value` with every vault-known token replaced by its original, for
 * the EXECUTION copy of allowlisted tool args. `substituted` reports whether
 * anything changed; when false (no vault-known token anywhere), the ORIGINAL
 * object is returned — no rebuild, reference-identical, so byte-faithful
 * callers can assert the passthrough. Unknown or confabulated tokens pass
 * verbatim (substituteTokens' contract): they cannot abort a tool call.
 */
export function dereferenceToolArgs<T>(vault: TokenVault | undefined, value: T): { args: T; substituted: boolean } {
	if (!vault) return { args: value, substituted: false }
	let substituted = false
	for (const text of deepStrings(value)) {
		if (text.includes("[") && substituteTokens(vault, text) !== text) {
			substituted = true
			break
		}
	}
	if (!substituted) return { args: value, substituted: false }
	return { args: substituteTokensDeep(vault, value) as T, substituted: true }
}

/**
 * The single entry point every tool-registration execute uses: resolves the
 * session vault and apply the EXEC_DEREF_TOOLS allowlist. A missing vault
 * (markers mode, dead/resumed session, redaction off) or a non-allowlisted
 * tool returns `params` untouched.
 */
export function derefToolArgsForExecution<T>(sessionId: string | undefined, toolName: string, params: T): T {
	if (!EXEC_DEREF_TOOLS.has(toolName)) return params
	return dereferenceToolArgs(vaultForSession(sessionId), params).args
}

// ---------------------------------------------------------------------------
// Session lifecycle (module-global — the ACP server hosts concurrent
// sessions in one process, so this state must key by session id and tear
// down scoped to its owner, per the shared-state rules).
// ---------------------------------------------------------------------------

/**
 * Live vault entries, keyed by session id. `owners` are the sessionManager
 * objects of EVERY session that has claimed the mapping: id keys recycle
 * across respawns while an old session's shutdown emission is still
 * awaited (close aborts first), and concurrent same-id attaches (load +
 * resume coalesce separately; a failed attach can still have observed a
 * session_start) overlap in the same way. Ownership-adopting on start is
 * NOT enough — a later FAILURE of that attach fires its shutdown, which
 * would steal-retire the survivor's vault. Multi-owner instead: shutdown
 * removes ONLY its own owner entry; the vault outlives its creator while
 * any owner remains (tokens already stored must keep resolving), and is
 * evicted when the LAST owner shuts down — exact-owner semantics per the
 * shared-state rules, with no steal possible.
 */
const vaultEntries = new Map<string, { vault: TokenVault; owners: object[] }>()

/**
 * The vault the TUI markdown transformer should substitute against. The
 * transformer API receives no session identity; the TUI paints one session
 * at a time, so session_start/session_shutdown maintain this pointer. ACP
 * never uses it — the ACP server looks vaults up by session id directly.
 */
let currentVault: TokenVault | undefined

/** The vault for a session, or undefined when none is active (not token mode / session unknown). */
export function vaultForSession(sessionId: string | undefined): TokenVault | undefined {
	if (sessionId === undefined || sessionId.length === 0) return undefined
	return vaultEntries.get(sessionId)?.vault
}

/** The TUI paint-time vault (singular — TUI paints one session at a time). */
export function vaultForPaint(): TokenVault | undefined {
	return currentVault
}

/**
 * Register the lifecycle once per extension factory invocation: create the
 * vault for this session on start, drop it on shutdown. A repeated
 * session_start with a live vault keeps the existing mapping rather than
 * orphaning it — tokens already stored in the session file must keep
 * resolving for this process lifetime.
 *
 * Exported separately so tests wire the same lifecycle the extension does.
 */
export function installVaultLifecycle(pi: ExtensionAPI, enabled: () => boolean): void {
	pi.on("session_start", async (_event: unknown, ctx: unknown) => {
		if (!enabled()) return
		const sessionManager = (ctx as { sessionManager?: unknown })?.sessionManager
		const sessionId = (sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.()
		if (!sessionId) return
		// TUI switches sessions with shutdown/start pairs; ACP keys by id. A
		// vault that outlived its creator is retained and CO-OWNED across
		// respawns — tokens already stored in the session file must keep
		// resolving — without any ownership steal.
		const existing = vaultEntries.get(sessionId)
		if (existing) {
			if (!existing.owners.includes(sessionManager as object)) existing.owners.push(sessionManager as object)
			currentVault = existing.vault
			return
		}
		// Seed past every token already persisted for this session BEFORE
		// any allocation (the vault is installed only after the sweep), so a
		// resumed session can never re-issue a stored token for a different
		// value: resume degradation must render old tokens verbatim, never
		// substitute a wrong original.
		const getEntries = (sessionManager as { getEntries?: () => unknown[] } | undefined)?.getEntries
		const entries = typeof getEntries === "function" ? getEntries.call(sessionManager) : []
		const observed = await seedTokenCountersChunked(deepStrings(entries))
		if (observed.size > 0) {
			// Suffix maxima only — never the originals, which must not reach logs.
			const summary = [...observed].map(([entity, max]) => `${entity}<=${max}`).join(", ")
			console.error(`PII redaction token seed: counters raised from persisted session (${summary})`)
		}
		// Recheck across the chunked awaits: a concurrent start of the same
		// id may have installed a mapping while we yielded — co-own, don't steal.
		const raced = vaultEntries.get(sessionId)
		if (raced) {
			if (!raced.owners.includes(sessionManager as object)) raced.owners.push(sessionManager as object)
			currentVault = raced.vault
			return
		}
		const vault = createTokenVault()
		vaultEntries.set(sessionId, { vault, owners: [sessionManager as object] })
		currentVault = vault
	})

	pi.on("session_shutdown", async (_event: unknown, ctx: unknown) => {
		const sessionManager = (ctx as { sessionManager?: unknown })?.sessionManager
		const sessionId = (sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.()
		if (!sessionId) return
		const entry = vaultEntries.get(sessionId)
		if (!entry) return
		// Remove ONLY this session's ownership: a concurrent respawn's (or
		// failed attach's) shutdown must not retire a vault still owned by a
		// live session. The mapping is evicted only by its LAST owner — a
		// dead-owner-only mapping is treated as empty (its vault degrades to
		// verbatim anyway), so late starts of a dead-owner mapping simply
		// adopt it.
		entry.owners = entry.owners.filter((owner) => owner !== sessionManager)
		if (entry.owners.length > 0) return
		vaultEntries.delete(sessionId)
		// Only clear the paint pointer when it still points at the dead
		// session's vault (shutdown/start ordering).
		if (currentVault === entry.vault) currentVault = undefined
	})
}

/** Reset all lifecycle state AND the process-wide counters — test isolation only. */
export function resetTokenVaults(): void {
	vaultEntries.clear()
	currentVault = undefined
	tokenCounters.clear()
}
