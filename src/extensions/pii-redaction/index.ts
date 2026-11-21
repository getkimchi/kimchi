/**
 * PII redaction extension.
 *
 * Uses three scrubbing hooks to keep PII/secrets out of the message
 * pipeline with minimal per-request overhead:
 *
 * 1. `message_end` — redacts every persisted message (user, assistant,
 *    toolResult, system) in place before storage: the runner applies the
 *    returned replacement to the same object it then persists, so the
 *    stored entry carries the scrubbed content under the original
 *    reference. One-time cost per message.
 *
 * 2. `tool_result` — redacts tool result content and its `details` mirror
 *    before they are persisted. One-time cost per tool call; the stored
 *    result is already clean, and message_end's later walk over the
 *    toolResult message nets to zero (single emission per redaction).
 *
 * 3. `before_provider_request` — redacts every non-system message in the
 *    request payload, using a WeakMap cache keyed by message reference so
 *    previously-redacted messages are O(1) lookups. Only cache misses
 *    (new or restored-unattested messages) incur scanning cost. A scan that
 *    failed open is never cached — the next request rescans it.
 *
 * This design means:
 * - The session file is scrubbed by the time a message lands in it
 * - Per-request cost is O(new messages) not O(total messages)
 * - No memory doubling — the WeakMap holds one redacted reference per
 *   message and is GC'd when the session manager drops the original
 *
 * Resume attestation (turn_end + session_start) — attest and forget:
 * - A message_end scan that completes with zero engine failures marks the
 *   message object as clean-scrubbed. At each turn end one
 *   `pii-redaction/attest` custom entry persists the turn's clean-scrubbed
 *   message ids (custom entries never enter LLM context).
 * - On startup/resume/fork, attested ids seed the request-walk cache, so
 *   a resumed session does not re-scan history the write path scrubbed —
 *   content-independent, so PII-heavy sessions benefit equally.
 * - Anything without evidence — legacy files, fail-open scans, writes
 *   made with redaction off, broken object identity — falls back to
 *   today's full scan on every resume. There is deliberately no
 *   fingerprint and no healing: policy/build changes do NOT re-redact
 *   attested lines (accepted risk — the live pipeline applied the
 *   then-current policy when the line ran, so anything a future policy
 *   would newly redact was already sent to the provider at that time),
 *   and the request hook records no evidence, so a stored message that
 *   never went through a live write-path scrub is never attested.
 * - Trust boundary: the local session file, the same as the token vault
 *   seed in vault.ts.
 *
 * Redaction is disabled by default. It is governed by the resources system:
 *   - /resources toggle or settings.json resources override
 *   - KIMCHI_ENABLE_RESOURCES=extensions.pii-redaction env (transient)
 *   - the org policy's kimchiResources entry (ON/OFF defaults, FORCE_* locks)
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { PII_ATTEST_ENTRY_TYPE, parseAttestEntry, sessionEntriesFrom, sessionManagerFrom } from "./attestation.js"
import { getRedactionRenderMode, isRedactionEnabled } from "./config.js"
import { emitRedactionFacts, type RedactionSurface } from "./redaction-events.js"
import {
	emptyRedactionReport,
	mergeReports,
	type RedactionMeasurement,
	redactObjectStringsMeasured,
} from "./redactor.js"
import { installVaultLifecycle, substituteTokens, type TokenVault, vaultForPaint, vaultForSession } from "./vault.js"

/**
 * Resolve the session's token vault for a hook, or undefined when the
 * rendering policy is markers (default). A missing session identity always
 * redacts to markers — markers degrade gracefully in every downstream
 * surface; a token without its vault would render as dead text.
 */
function hookVault(ctx: unknown): TokenVault | undefined {
	if (getRedactionRenderMode() !== "tokens") return undefined
	const sessionId = (sessionManagerFrom(ctx) as { getSessionId?: () => string } | undefined)?.getSessionId?.()
	return vaultForSession(sessionId)
}

/** Cache of redacted messages, keyed by original message reference. */
const redactionCache = new WeakMap<object, object>()
/**
 * In-flight redactions, keyed like the cache — checked and populated
 * synchronously before the first await, so two concurrent cache-miss paths
 * for the same message reference (e.g. one request payload carrying the
 * same object twice) await one redaction and emit its facts exactly once.
 * Retention bound: keys are STRONG references, held until the redaction
 * settles — and settlement is bounded per string (SCAN_SETTLE_TIMEOUT_MS
 * per scanned string), not per message. Under a degraded engine, a
 * many-string message can therefore pin its original object for minutes
 * past session disposal, and the shared promise couples any concurrent
 * payload carrying the same reference.
 */
const redactionInFlight = new Map<object, Promise<RedactionMeasurement<object>>>()

/**
 * Write-time evidence that a message's full scan completed clean (zero
 * engine failures). Keyed by the message object that gets persisted —
 * message_end replacements are applied in place, so the entry's message
 * keeps this reference. Attest-and-forget: no fingerprint, no digest —
 * see attestation.ts for the accepted-risk rationale.
 */
const cleanScrubbed = new WeakSet<object>()

/**
 * Per-sessionManager attestation bookkeeping — object-keyed, so concurrent
 * ACP sessions (one process, many sessionManagers) never share state and a
 * session's teardown never touches another's.
 */
const attestedIds = new WeakMap<object, Set<string>>()

function attestedIdsFor(manager: object): Set<string> {
	let ids = attestedIds.get(manager)
	if (!ids) {
		ids = new Set()
		attestedIds.set(manager, ids)
	}
	return ids
}

/** Map a request-message role to the redaction surface it belongs to. */
function surfaceForRole(role: unknown): RedactionSurface | undefined {
	if (role === "user") return "user_input"
	if (role === "assistant") return "assistant_message"
	if (role === "toolResult") return "tool_result"
	return undefined
}

const piiRedactionExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	// Vault lifecycle: one reversible-token vault per session when the
	// configured render mode is "tokens" (markers mode creates nothing).
	installVaultLifecycle(pi, () => isRedactionEnabled() && getRedactionRenderMode() === "tokens")

	// TUI presentation substitution: the upstream paint path passes the
	// FULL text of each message block through this transformer on every
	// repaint (streaming or final), so substituting complete tokens here
	// shows originals to the local user while the stored transcript stays
	// tokenized. Markers mode has no active vault → passthrough. Unknown
	// tokens (never allocated, foreign-session, post-restart) pass through
	// verbatim — substitution must never be a wrong transformation. The
	// stored message never changes.
	if (typeof pi.registerMarkdownTransformer === "function") {
		pi.registerMarkdownTransformer((markdown: string) => {
			const vault = vaultForPaint()
			if (!vault) return markdown
			return substituteTokens(vault, markdown)
		})
	}

	// 1. Redact assistant messages before they are stored.
	pi.on("message_end", async (event: unknown, ctx: unknown) => {
		// Non-throwing gate: a broken settings block must not reject the hook
		// (the extension runner discards rejected results — unredacted storage).
		if (!isRedactionEnabled()) return

		const evt = event as Record<string, unknown> | null
		if (!evt || typeof evt !== "object") return

		const message = evt.message
		if (!message || typeof message !== "object") return

		// Redact the message content (deep-walk all strings).
		const { redacted, report } = await redactObjectStringsMeasured(message, hookVault(ctx))
		// Write-time evidence for resume attestation: this scan completed
		// with zero engine failures. The runner applies the final replacement
		// in place to the ORIGINAL event.message, so `message` here (the object
		// this handler received) is the persisted object only while no
		// earlier-ordered message_end handler returned a fresh replacement
		// first. When one does, this evidence keys an intermediate object and
		// never matches an entry — fail-safe (no attest, rescan on resume).
		if (report.engineFailures === 0) cleanScrubbed.add(message)
		// Emit redaction facts labelled by message role. message_end fires for
		// user and assistant messages (and system messages — redacted for
		// storage hygiene but never emitted, since they are not user data).
		// The user case is where most user_input facts originate: message_end
		// runs before before_provider_request sees the message, so the request
		// hook usually re-scans already-redacted text and reports nothing.
		const surface = surfaceForRole((message as { role?: string }).role)
		if (surface) emitRedactionFacts(pi, surface, report)
		// biome-ignore lint/suspicious/noExplicitAny: MessageEndEventResult.message type is AgentMessage but we operate on unknown
		return { message: redacted } as any
	})

	// 2. Redact tool result content (and its `details` mirror) before it is
	// persisted. The runner keeps the event's original `details` verbatim
	// when a handler returns only `content`, so an un-redacted `details` copy
	// would otherwise reach message_end's storage walk and emit a second
	// tool_result fact for the same redaction. Redacting it here makes this
	// hook the single emission owner for tool results: message_end's later
	// deep walk finds only markers and nets to zero. Handlers registered
	// after this one in the tool_result chain see redacted `details` — the
	// same contract tool-output-externalizer documents for content.
	pi.on("tool_result", async (event: unknown, ctx: unknown) => {
		// Non-throwing gate: a broken settings block must not reject the hook
		// (the extension runner discards rejected results — unredacted storage).
		if (!isRedactionEnabled()) return

		const evt = event as Record<string, unknown> | null
		if (!evt || typeof evt !== "object") return

		// `details` is redacted regardless of the content shape: a non-array
		// `content` must not skip the details copy (this hook is the single
		// emission owner for every tool result). Presence is captured once —
		// the merge below gates on it, never on the measurement's truthiness.
		const hasDetails = evt.details !== undefined
		const content = evt.content

		const aggregate = emptyRedactionReport()
		// Content and details scan concurrently: each string scan is
		// settle-bounded, so serializing the two groups would double the
		// hook's worst-case stall under a degraded engine. Both merge into
		// the same per-invocation aggregate before the single emission below.
		// The details scan is isolated (failure resolves undefined): the hook
		// still returns the content redaction, the original details is kept,
		// and message_end's walk scrubs it — the pre-fix failure behavior, so
		// a details-side failure never discards a content redaction that
		// already succeeded.
		const [redactedContent, detailsMeasured] = await Promise.all([
			Array.isArray(content)
				? Promise.all(
						content.map(async (block: unknown) => {
							if (block === null || typeof block !== "object") return block
							const b = block as Record<string, unknown>
							if (b.type === "text" && typeof b.text === "string") {
								const { redacted, report } = await redactObjectStringsMeasured(b.text, hookVault(ctx))
								mergeReports(aggregate, report)
								return { ...b, text: redacted }
							}
							return block
						}),
					)
				: undefined,
			hasDetails
				? redactObjectStringsMeasured(evt.details, hookVault(ctx)).catch((err: unknown) => {
						// Log here: the failure signal would otherwise only resurface
						// (mis-attributed to message_end) when the later walk re-scrubs
						// the kept original details — or not at all if redaction is
						// toggled off in between.
						console.error("PII redaction details scan failed, keeping original details:", err)
						return undefined
					})
				: undefined,
		])
		// The `details` object mirrors the rendered content (e.g.
		// details.display.output repeats content[].text) — redacted in the
		// same invocation so each copy is scanned and reported exactly once.
		// Both keys are returned only when they apply: the runner treats an
		// absent key as "not replaced" and keeps the original.
		const result: { content?: unknown; details?: unknown } = {}
		if (redactedContent !== undefined) result.content = redactedContent
		if (hasDetails && detailsMeasured) {
			mergeReports(aggregate, detailsMeasured.report)
			result.details = detailsMeasured.redacted
		}
		emitRedactionFacts(pi, "tool_result", aggregate)

		// biome-ignore lint/suspicious/noExplicitAny: ToolResultEventResult.content type is (TextContent | ImageContent)[] but we operate on unknown
		return result as any
	})

	// 3. Redact user messages before the LLM request, using a cache so
	//    previously-redacted messages are not re-scanned.
	pi.on("before_provider_request", async (event: unknown, ctx: unknown) => {
		const payload = (event as Record<string, unknown> | null)?.payload as Record<string, unknown> | null
		if (!payload || typeof payload !== "object") return

		const messages = payload.messages
		if (!Array.isArray(messages)) return

		// Non-throwing gate: a broken settings block must not reject the hook
		// (the extension runner discards rejected results — unredacted storage).
		if (!isRedactionEnabled()) return

		// The vault is resolved once per hook invocation — every message in
		// this payload allocates into the same session vault, so a value is
		// the same token whether it first appeared in a tool result or the
		// user's next message.
		const vault = hookVault(ctx)

		// Walk messages: system messages pass through unchanged, non-system
		// messages are redacted (or fetched from cache if already redacted).
		const redacted = await Promise.all(
			messages.map(async (msg) => {
				if (msg === null || typeof msg !== "object") return msg
				const message = msg as Record<string, unknown>
				// Skip system messages — they contain structural identifiers.
				if (message.role === "system") return msg
				// Cache hit — return previously redacted version.
				const cached = redactionCache.get(msg)
				if (cached) return cached
				// Cache miss. Synchronously register the in-flight promise before
				// the first await, so every concurrent miss for this same object
				// (a payload carrying the reference twice) shares one redaction —
				// exactly one emission per message, not one per occurrence.
				let inFlight = redactionInFlight.get(msg)
				const isEmitter = !inFlight
				if (!inFlight) {
					inFlight = redactObjectStringsMeasured(msg, vault) as Promise<RedactionMeasurement<object>>
					redactionInFlight.set(msg, inFlight)
					inFlight.finally(() => redactionInFlight.delete(msg)).catch(() => {})
				}
				const { redacted: redactedMsg, report } = await inFlight
				if (isEmitter) {
					// Never cache a pass that failed open: the original text was
					// returned for some strings, so the next request must rescan.
					// (Previously a failed scan was cached as if clean until
					// restart.) Facts are still emitted for what was found.
					if (report.engineFailures === 0) {
						redactionCache.set(msg, redactedMsg as object)
					}
					// Facts are labelled by the message role — a cache-miss
					// assistant-message in restored history must not inflate the
					// user_input dimension.
					const surface = surfaceForRole(message.role)
					if (surface) emitRedactionFacts(pi, surface, report)
				}
				return redactedMsg
			}),
		)

		payload.messages = redacted
		return payload
	})

	// 4. Persist write-time evidence: at each turn end, append one attest
	//    entry per fingerprint for the turn's clean-scrubbed messages, so a
	//    resumed process can skip re-proving them. The walk re-probes every
	//    entry each turn (no cursor): getEntries() already copies the whole
	//    array per call, the per-entry probe is a WeakMap lookup, and a
	//    message that only gains evidence later (healing, after an
	//    earlier-ordered message_end handler broke write-time keying) is
	//    still picked up by the next turn end.
	pi.on("turn_end", async (_event: unknown, ctx: unknown) => {
		// Non-throwing gate, as everywhere: a throwing hook's result is
		// discarded by the runner, and here there is nothing to discard.
		if (!isRedactionEnabled()) return
		try {
			const manager = sessionManagerFrom(ctx)
			if (!manager || typeof manager !== "object") return
			const entries = sessionEntriesFrom(ctx)
			if (!entries) return
			// getEntries() returns the whole append-only entry tree — the walk
			// covers every branch, including abandoned ones; attest entries
			// land at the current leaf, and ids outside the live branch simply
			// never match a seeding read.
			const attested = attestedIdsFor(manager)
			const ids: string[] = []
			for (const entry of entries) {
				if (entry?.type !== "message" || typeof entry.id !== "string") continue
				if (attested.has(entry.id)) continue
				const message = entry.message
				// No evidence (never scrubbed by this process's write path) —
				// never attest.
				if (message === null || typeof message !== "object" || !cleanScrubbed.has(message)) continue
				ids.push(entry.id)
			}
			if (ids.length > 0) {
				// appendEntry is write-time only; a stale extension context
				// (session replaced mid-flight) throws and lands in the catch —
				// those messages simply stay unattested.
				pi.appendEntry(PII_ATTEST_ENTRY_TYPE, { v: 1, ids })
				for (const id of ids) attested.add(id)
			}
		} catch (err) {
			// Best-effort by design: a dropped attestation costs a rescan on
			// resume, never a leak. But a PERSISTENT failure here silently
			// reintroduces the resume regression — log it so an operator can
			// tell "attestation off" from "attestation broken".
			console.error("PII redaction attest append failed; messages stay unattested:", err)
		}
	})

	// 5. Seed the request-walk cache from attestation on session start, so a
	//    resumed session does not re-scan history the write path proved clean.
	//    The identity chain this relies on (reopened file → same message
	//    object references in the provider payload) is pinned by the
	//    real-SessionManager contract test in index.test.ts.
	pi.on("session_start", async (event: unknown, ctx: unknown) => {
		if (!isRedactionEnabled()) return
		// `reload`/`new` must not seed: a live session whose tail was written
		// with redaction off would be trusted without evidence. Only a fresh
		// read from disk (startup/resume/fork) carries file-backed evidence.
		const reason = (event as { reason?: unknown } | null)?.reason
		if (reason !== "startup" && reason !== "resume" && reason !== "fork") return
		try {
			const manager = sessionManagerFrom(ctx)
			if (!manager || typeof manager !== "object") return
			const entries = sessionEntriesFrom(ctx)
			if (!entries) return
			const trusted = new Set<string>()
			for (const entry of entries) {
				if (entry?.type !== "custom" || entry.customType !== PII_ATTEST_ENTRY_TYPE) continue
				// Malformed data: ignore wholesale — those messages are
				// rescanned instead.
				const ids = parseAttestEntry(entry.data)
				if (ids) for (const id of ids) trusted.add(id)
			}
			if (trusted.size === 0) return
			const attested = attestedIdsFor(manager)
			for (const entry of entries) {
				if (entry?.type !== "message" || typeof entry.id !== "string") continue
				const message = entry.message
				if (!trusted.has(entry.id) || message === null || typeof message !== "object") continue
				// Stored content is the write path's scrubbed form — idempotent
				// under rescans, so the message is its own redacted form.
				redactionCache.set(message, message)
				// Mark attested so the first turn_end does not re-append them.
				attested.add(entry.id)
			}
		} catch (err) {
			// No seeding — the request walk scans everything, as today. Log
			// so "seeding unavailable" is distinguishable from "nothing
			// attested" when the resume regression resurfaces.
			console.error("PII redaction resume seeding failed; falling back to full scan:", err)
		}
	})
}

export default piiRedactionExtension
