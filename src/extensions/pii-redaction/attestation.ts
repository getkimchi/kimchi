/**
 * Write-time attestation for pii-redaction resume seeding.
 *
 * A stored message is skipped by the resume request-walk only when the
 * session file carries positive evidence that a full scan of it completed
 * with zero engine failures, under the same detection fingerprint the
 * current process would use. Evidence is an extension-owned custom
 * entry (`pii-redaction/attest`) appended once per turn; custom entries never
 * enter LLM context, so the attest stream is invisible to the model.
 *
 * Each attested id carries a digest of the message content the clean scan
 * saw, so seeding re-verifies content: drift between the attest write and
 * the resume (a hand-edit, a partially written file) fails closed into a
 * rescan. Within a process, the same digest guards turn_end against
 * post-scan in-place mutation.
 *
 * Trust boundary: the local session file — the same boundary as the token
 * vault seed in vault.ts. A forged entry in a hand-edited or foreign file
 * can only skip scrubbing of that file's own content.
 */

import { createHash } from "node:crypto"

/** The custom-entry type used for attestation evidence. */
export const PII_ATTEST_ENTRY_TYPE = "pii-redaction/attest"

/**
 * Attestation schema version — the single source for the written `v` field,
 * the read-side validation, and the fingerprint payload. Bump it when the
 * entry shape or the fingerprint derivation changes: old entries must stop
 * validating rather than be misread. Deriving all three from one constant
 * keeps writer, reader, and fingerprint locked together by construction.
 */
export const ATTEST_SCHEMA_VERSION = 1

/** One attested message entry: its id and the digest of its scanned content. */
export interface AttestedId {
	id: string
	d: string
}

/** Attest entry shape. `v` exists so old entries stop validating when the shape changes. */
export interface AttestEntryData {
	v: typeof ATTEST_SCHEMA_VERSION
	/** Detection fingerprint the attested scans ran under. */
	fp: string
	/** The turn's clean-scrubbed messages with their content digests. */
	ids: AttestedId[]
}

/**
 * Validate an attest entry's data against the current fingerprint.
 * Returns the per-id evidence to trust, or undefined when the data is
 * malformed or was produced under a different detection policy/build (in
 * which case the messages are rescanned instead). Fail-closed on any
 * malformed element: a structurally corrupt entry voids wholesale rather
 * than partially honoring its well-formed ids.
 */
export function parseAttestEntry(data: unknown, fingerprint: string): AttestedId[] | undefined {
	if (data === null || typeof data !== "object") return undefined
	const d = data as { v?: unknown; fp?: unknown; ids?: unknown }
	if (d.v !== ATTEST_SCHEMA_VERSION || d.fp !== fingerprint || !Array.isArray(d.ids)) return undefined
	const out: AttestedId[] = []
	for (const item of d.ids) {
		if (item === null || typeof item !== "object") return undefined
		const e = item as { id?: unknown; d?: unknown }
		if (typeof e.id !== "string" || typeof e.d !== "string") return undefined
		out.push({ id: e.id, d: e.d })
	}
	return out.length > 0 ? out : undefined
}

/**
 * Stable digest of a message, used to bind attestation to content: an
 * entry is attested only while its message is byte-identical (same JSON) to
 * what the clean scan produced. A later in-place mutation — by another
 * extension's message_end handler or anything else — voids the evidence
 * (safe direction: rescan). Agent messages are JSON-serializable by
 * construction (they are persisted as JSONL), so stringify cannot cycle.
 * Returns undefined for unserializable input; callers treat that as
 * "no evidence".
 */
export function messageDigest(message: unknown): string | undefined {
	try {
		const serialized = JSON.stringify(message)
		if (serialized === undefined) return undefined
		return createHash("sha256").update(serialized).digest("hex")
	} catch {
		return undefined
	}
}

/**
 * The sessionManager object a hook ctx carries, when present — the shared
 * duck-typed extraction for every extension site that needs it (keying
 * per-session state, reading entries). Object-typed so WeakMap keys stay
 * honest; callers feature-detect the members they need.
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
