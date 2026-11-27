import { createHash } from "node:crypto"
/**
 * Write-time attestation for pii-redaction resume seeding.
 *
 * A stored message is skipped by the resume request-walk only when the
 * session file carries positive evidence that the write path scrubbed it:
 * a `message_end` scan that completed with zero engine failures. At each
 * turn end one `pii-redaction/attest` custom entry persists the ids of
 * the turn's clean-scrubbed messages; custom entries never enter LLM
 * context, so the attest stream is invisible to the model.
 *
 * Deliberately minimal — attest and forget:
 * - No detection fingerprint. A policy or build change does NOT re-redact
 *   attested lines. Accepted risk: the live pipeline applied the
 *   then-current policy when the line ran, so anything a future policy
 *   would newly redact was already sent to the provider at that time;
 *   re-scanning cannot undo the first exposure.
 * - No healing: the request hook records no evidence, so a stored message
 *   that never went through a live message_end scrub (legacy files,
 *   writes made with redaction off, broken object identity) is never
 *   attested and is rescanned on every resume — today's behavior.
 *
 * Trust boundary: the local session file — the same boundary as the token
 * vault seed in vault.ts. A forged entry in a hand-edited or foreign file
 * can only skip scrubbing of that file's own content.
 */

/** The custom-entry type used for attestation evidence. */
export const PII_ATTEST_ENTRY_TYPE = "pii-redaction/attest"

/**
 * Digest of one string — the shared primitive behind attestation: the
 * clean-string memo (skip rescans of strings proven clean), the sent-gate
 * (a message attests only once a request payload carried its text), and
 * the scan-record (a message attests only while its content is exactly
 * what the clean scan produced). Content-keyed throughout: no hook in
 * the request path preserves message-object identity, so attestation
 * never relies on references.
 */
export function stringDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex")
}

/**
 * The text-content strings of a message-shaped object — plain-string
 * content plus `text` blocks. Works on both the stored AgentMessage form
 * and the provider wire form: text survives wire conversion verbatim
 * (tool-call arguments are re-serialized, so they are deliberately not
 * included — a re-serialization of a scanned-clean value cannot introduce
 * content, and comparing it would never match).
 */
export function textContentStrings(message: unknown): string[] {
	if (message === null || typeof message !== "object") return []
	const content = (message as { content?: unknown }).content
	if (typeof content === "string") return [content]
	if (!Array.isArray(content)) return []
	const out: string[] = []
	for (const block of content) {
		if (block === null || typeof block !== "object") continue
		if ((block as { type?: unknown }).type !== "text") continue
		const text = (block as { text?: unknown }).text
		if (typeof text === "string") out.push(text)
	}
	return out
}

/**
 * Attest entry shape. `v` exists so old entries stop validating when the
 * shape changes, rather than being misread.
 */
export interface AttestEntryData {
	v: 1
	/** Ids of `message` entries whose write-path scan completed clean. */
	ids: string[]
}

/**
 * Validate an attest entry's data. Returns the entry ids to trust, or
 * undefined when malformed — fail-closed wholesale on any bad element
 * rather than partially honoring well-formed ids.
 */
export function parseAttestEntry(data: unknown): string[] | undefined {
	if (data === null || typeof data !== "object") return undefined
	const d = data as { v?: unknown; ids?: unknown }
	if (d.v !== 1 || !Array.isArray(d.ids)) return undefined
	const ids = d.ids.filter((id): id is string => typeof id === "string")
	return ids.length === d.ids.length && ids.length > 0 ? ids : undefined
}

/**
 * The sessionManager object a hook ctx carries, when present — the shared
 * duck-typed extraction for every extension site that needs it (keying
 * per-session state, reading entries). Object-typed so WeakMap/WeakSet keys
 * stay honest; callers feature-detect the members they need.
 */
export function sessionManagerFrom(ctx: unknown): unknown {
	return (ctx as { sessionManager?: unknown } | undefined)?.sessionManager
}

/** Entries view the attest hooks read — the subset of the session shape they touch. */
export interface AttestableEntry {
	type?: unknown
	id?: unknown
	message?: unknown
	customType?: unknown
	data?: unknown
}

/** The ctx's session entries, when a readable sessionManager with getEntries is present. */
export function sessionEntriesFrom(ctx: unknown): AttestableEntry[] | undefined {
	const manager = sessionManagerFrom(ctx)
	if (!manager || typeof manager !== "object") return undefined
	const getEntries = (manager as { getEntries?: () => unknown } | undefined)?.getEntries
	if (typeof getEntries !== "function") return undefined
	const entries = getEntries.call(manager)
	return Array.isArray(entries) ? (entries as AttestableEntry[]) : undefined
}
