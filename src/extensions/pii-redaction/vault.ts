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
export function seedTokenCountersFromTexts(texts: Iterable<string>): Map<string, number> {
	const observed = new Map<string, number>()
	for (const text of texts) {
		SEED_RE.lastIndex = 0
		let match = SEED_RE.exec(text)
		while (match !== null) {
			const entity = match[1]
			const suffix = Number.parseInt(match[2], 10)
			if (entity !== undefined && Number.isSafeInteger(suffix)) {
				if ((observed.get(entity) ?? 0) < suffix) observed.set(entity, suffix)
				if ((tokenCounters.get(entity) ?? 0) < suffix) tokenCounters.set(entity, suffix)
			}
			match = SEED_RE.exec(text)
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

// ---------------------------------------------------------------------------
// Session lifecycle (module-global — the ACP server hosts concurrent
// sessions in one process, so this state must key by session id and tear
// down scoped to its owner, per the shared-state rules).
// ---------------------------------------------------------------------------

/** Live vaults, keyed by session id. */
const vaultsBySession = new Map<string, TokenVault>()

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
	return vaultsBySession.get(sessionId)
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
		const sessionId = (ctx as { sessionManager?: { getSessionId?: () => string } })?.sessionManager?.getSessionId?.()
		if (!sessionId) return
		// TUI switches sessions with shutdown/start pairs; ACP keys by id.
		// A vault that outlived its creator is retained — see doc above.
		if (!vaultsBySession.has(sessionId)) {
			// Seed past every token already persisted for this session BEFORE
			// any allocation, so a resumed session can never re-issue a stored
			// token for a different value (resume degradation must render old
			// tokens verbatim, never substitute a wrong original).
			const sessionManager = (ctx as { sessionManager?: { getEntries?: () => unknown[] } })?.sessionManager
			const entries = typeof sessionManager?.getEntries === "function" ? sessionManager.getEntries() : []
			seedTokenCountersFromTexts(deepStrings(entries))
			vaultsBySession.set(sessionId, createTokenVault())
		}
		currentVault = vaultsBySession.get(sessionId)
	})

	pi.on("session_shutdown", async (_event: unknown, ctx: unknown) => {
		const sessionId = (ctx as { sessionManager?: { getSessionId?: () => string } })?.sessionManager?.getSessionId?.()
		if (!sessionId) return
		// The vault IS this key's value, so by-key removal is the identity
		// check; the hazard worth guarding is clearing the paint pointer for
		// a session that just respawned (shutdown/start ordering), so only
		// clear it when it still points at the dead session's vault.
		const vault = vaultsBySession.get(sessionId)
		vaultsBySession.delete(sessionId)
		if (currentVault === vault) currentVault = undefined
	})
}

/** Reset all lifecycle state AND the process-wide counters — test isolation only. */
export function resetTokenVaults(): void {
	vaultsBySession.clear()
	currentVault = undefined
	tokenCounters.clear()
}
