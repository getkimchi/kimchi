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
 *    provider's wire payload. The payload's message objects are rebuilt
 *    by the provider adapters on every request and the Agent-level
 *    context events hand handlers structured clones, so NOTHING in the
 *    request path preserves message-object identity — caches keyed by
 *    reference can never hit there. The cost control is the clean-string
 *    memo instead (redactor.ts): a string whose full scan completed clean
 *    is never scanned again in this process. Per-request cost is
 *    O(unique new strings), not O(total history).
 *
 * This design means:
 * - The session file is scrubbed by the time a message lands in it
 * - Per-request cost is O(unique new strings), in-session and on resume
 * - The strict export path never passes the memo and keeps its
 *   fail-closed rescan
 *
 * Resume attestation (turn_end + session_start) — attest and forget,
 * content-keyed throughout:
 * - A message_end scan that completes with zero engine failures records a
 *   scan-record on the message object: the digests of the scan output's
 *   strings — exactly what we vouch for. At each turn end one
 *   `pii-redaction/attest` custom entry persists the ids of the turn's
 *   clean messages (custom entries never enter LLM context).
 * - A message attests only when BOTH gates hold: its current content is
 *   exactly the scan output (a later message_end handler's in-place
 *   mutation voids attestation), and every text-content string was
 *   observed in a request payload (a tool result whose carrying request
 *   never happened — an aborted turn — never attests and is rescanned
 *   on resume).
 * - On startup/resume/fork, attested ids seed the clean-string memo from
 *   the stored messages' strings — content-keyed, so the wire conversion's
 *   fresh objects hit the memo anyway; text survives conversion verbatim.
 * - Anything without evidence — legacy files, fail-open scans, writes
 *   made with redaction off, mutated or never-sent content — falls back
 *   to the scan. There is deliberately no fingerprint and no healing:
 *   policy/build changes do NOT re-redact attested lines (accepted risk —
 *   the live pipeline applied the then-current policy when the line ran,
 *   so anything a future policy would newly redact was already sent to
 *   the provider at that time).
 * - Trust boundary: the local session file, the same as the token vault
 *   seed in vault.ts.
 *
 * Redaction is disabled by default. It is governed by the resources system:
 *   - /resources toggle or settings.json resources override
 *   - KIMCHI_ENABLE_RESOURCES=extensions.pii-redaction env (transient)
 *   - the org policy's kimchiResources entry (ON/OFF defaults, FORCE_* locks)
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import {
	PII_ATTEST_ENTRY_TYPE,
	parseAttestEntry,
	sessionEntriesFrom,
	sessionManagerFrom,
	stringDigest,
	textContentStrings,
} from "./attestation.js"
import { getRedactionRenderMode, isRedactionEnabled } from "./config.js"
import { emitRedactionFacts, type RedactionSurface } from "./redaction-events.js"
import { emptyRedactionReport, mergeReports, redactObjectStringsMeasured } from "./redactor.js"
import {
	deepStrings,
	installVaultLifecycle,
	substituteTokens,
	type TokenVault,
	vaultForPaint,
	vaultForSession,
} from "./vault.js"

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

/**
 * The clean-string memo (redactor.ts): digests of strings whose full scan
 * completed clean. Shared by every hook that passes it — a string proven
 * clean once is never engine-scanned again in this process. Content-keyed
 * by necessity: no request-path hook preserves message-object identity.
 */
const cleanMemo = new Set<string>()

/**
 * Digests of text-content strings observed in a request payload (the
 * before_provider_request walk records them). The sent-gate for
 * attestation: a message attests only once every text string it stores has
 * been carried by some request — a tool result whose carrying request
 * never happened (aborted turn) never attests.
 */
const sentDigests = new Set<string>()

/**
 * Write-time evidence: for each message a message_end scan completed clean
 * for, the digests of the scan OUTPUT's strings — exactly the content we
 * vouch for — keyed by the message object the handler received. The runner
 * applies the final replacement in place to the original event.message, so
 * the entry's message keeps this reference only while no earlier-ordered
 * message_end handler returned a fresh replacement first; when one does,
 * the record keys an intermediate object and never matches an entry —
 * fail-safe (no attest, rescan on resume).
 */
const scanRecord = new WeakMap<object, string[]>()

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
		const { redacted, report } = await redactObjectStringsMeasured(message, hookVault(ctx), cleanMemo)
		// Write-time evidence: this scan completed with zero engine failures.
		// Record the digests of the scan OUTPUT — the content we vouch for.
		// turn_end re-verifies them against the entry's current content, so a
		// later handler's in-place mutation (or a replacement that wins the
		// chain) voids the evidence instead of attesting unscanned text.
		if (report.engineFailures === 0) {
			scanRecord.set(message, [...new Set([...deepStrings(redacted)].map(stringDigest))])
		}
		// Emit redaction facts labelled by message role. message_end fires for
		// user and assistant messages (and system messages — redacted for
		// storage hygiene but never emitted, since they are not user data).
		// The user case is where most user_input facts originate: message_end
		// runs before before_provider_request sees the message, so the request
		// walk usually re-scans already-redacted text and reports nothing.
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
								const { redacted, report } = await redactObjectStringsMeasured(b.text, hookVault(ctx), cleanMemo)
								mergeReports(aggregate, report)
								return { ...b, text: redacted }
							}
							return block
						}),
					)
				: undefined,
			hasDetails
				? redactObjectStringsMeasured(evt.details, hookVault(ctx), cleanMemo).catch((err: unknown) => {
						// Log here: the failure signal would otherwise only resurface
						// (mis-attributed to message_end) when the later walk re-scrubs
						// the kept original details — or not all if redaction is
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

	// 3. Redact the provider's wire payload before the LLM request. The wire
	//    objects are rebuilt per request (and the context events are clones),
	//    so identity caching is impossible here by construction — the
	//    clean-string memo is the cost control, and this walk is the
	//    universal net that redacts anything the storage hooks missed.
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

		// Sent-gate evidence: record the text-content strings this payload
		// carries, in wire form. Text survives conversion verbatim, so these
		// digests match the stored form's text at turn_end — a tool result
		// counts as sent only when a payload actually carried its text.
		for (const msg of messages) {
			if (msg === null || typeof msg !== "object") continue
			if ((msg as { role?: unknown }).role === "system") continue
			for (const text of textContentStrings(msg)) sentDigests.add(stringDigest(text))
		}

		// Walk messages: system messages pass through unchanged, non-system
		// messages are redacted through the memo (a duplicate reference in
		// one payload scans once — one emission per message, not per slot).
		const perPayload = new Map<object, Promise<unknown>>()
		const redacted = await Promise.all(
			messages.map((msg) => {
				if (msg === null || typeof msg !== "object") return msg
				const message = msg as Record<string, unknown>
				// Skip system messages — they contain structural identifiers.
				if (message.role === "system") return msg
				let scan = perPayload.get(msg)
				if (!scan) {
					scan = redactObjectStringsMeasured(msg, vault, cleanMemo).then((m) => {
						// Facts are labelled by the message role — a scanned
						// assistant-message in restored history must not
						// inflate the user_input dimension.
						const surface = surfaceForRole(message.role)
						if (surface) emitRedactionFacts(pi, surface, m.report)
						return m.redacted
					})
					perPayload.set(msg, scan)
				}
				return scan
			}),
		)

		payload.messages = redacted
		return payload
	})

	// 4. Persist write-time evidence: at each turn end, append one attest
	//    entry for the turn's clean messages that were actually sent, so a
	//    resumed process can skip re-proving them. The walk re-probes every
	//    entry each turn (no cursor): getEntries() already copies the whole
	//    array per call, and the per-entry probes are WeakMap/Set lookups.
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
			const ids: string[] = []
			const attested: object[] = []
			for (const entry of entries) {
				if (entry?.type !== "message" || typeof entry.id !== "string") continue
				const message = entry.message
				if (message === null || typeof message !== "object") continue
				const recorded = scanRecord.get(message)
				// No write-time evidence from this process — never attest.
				if (!recorded) continue
				// Content gate: the entry's current strings must be exactly the
				// scan output's — a later handler's in-place mutation (new or
				// removed text) voids attestation.
				const current = new Set([...deepStrings(message)].map(stringDigest))
				if (current.size !== recorded.length || !recorded.every((d) => current.has(d))) continue
				// Sent gate: every text-content string must have been observed
				// in a request payload — a tool result whose carrying request
				// never happened (aborted turn) never attests.
				if (!textContentStrings(message).every((t) => sentDigests.has(stringDigest(t)))) continue
				ids.push(entry.id)
				attested.push(message)
			}
			if (ids.length > 0) {
				// appendEntry is write-time only; a stale extension context
				// (session replaced mid-flight) throws and lands in the catch —
				// those messages simply stay unattested.
				pi.appendEntry(PII_ATTEST_ENTRY_TYPE, { v: 1, ids })
				// Consumed: a second turn_end over unchanged entries appends
				// nothing.
				for (const message of attested) scanRecord.delete(message)
			}
		} catch (err) {
			// Best-effort by design: a dropped attestation costs a rescan on
			// resume, never a leak. But a PERSISTENT failure here silently
			// reintroduces the resume regression — log it so an operator can
			// tell "attestation off" from "attestation broken".
			console.error("PII redaction attest append failed; messages stay unattested:", err)
		}
	})

	// 5. Seed the clean-string memo from attestation on session start, so a
	//    resumed session does not re-scan history the write path scrubbed.
	//    Content-keyed: the memo hits regardless of the wire conversion's
	//    fresh objects, because text survives conversion verbatim (pinned by
	//    the AgentSession scan-count e2e in attest-resume.test.ts).
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
			for (const entry of entries) {
				if (entry?.type !== "message" || typeof entry.id !== "string") continue
				const message = entry.message
				if (!trusted.has(entry.id) || message === null || typeof message !== "object") continue
				// Every string of an attested message was scanned clean at
				// write time — admit them to the memo.
				for (const text of deepStrings(message)) cleanMemo.add(stringDigest(text))
			}
		} catch (err) {
			// No seeding — the request walk scans everything, as today. Log
			// so "seeding unavailable" is distinguishable from "nothing
			// attested" when the resume regression resurfaces.
			console.error("PII redaction resume seeding failed; falling back to full scan:", err)
		}
	})
}

/** Test isolation: the memo sets are module-level; clear them between cases. */
export function resetAttestationStateForTests(): void {
	cleanMemo.clear()
	sentDigests.clear()
}

export default piiRedactionExtension
