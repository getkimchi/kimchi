/**
 * Safety limits for hostile input, aligned with claude-code (20 MB input cap,
 * 20 pages per read, 10-unit @file inline threshold) and Apache POI (100:1
 * inflate ratio over a 100 KB grace size).
 *
 * Every cap is checked BEFORE expensive parsing; every violation is a typed
 * DocumentError — extractors translate, never propagate library errors raw.
 */

export const DEFAULT_MAX_FILE_MB = 20
export const MAX_FILE_MB_ENV = "KIMCHI_DOCUMENT_MAX_MB"

/**
 * Effective input cap in bytes. `KIMCHI_DOCUMENT_MAX_MB` overrides the
 * 20 MB default (mirrors claude-code's override pattern for read limits).
 */
export function maxFileBytes(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[MAX_FILE_MB_ENV]
	if (raw !== undefined) {
		const parsed = Number.parseInt(raw, 10)
		if (Number.isFinite(parsed) && parsed > 0) return parsed * 1024 * 1024
	}
	return DEFAULT_MAX_FILE_MB * 1024 * 1024
}

// --- Zip (OOXML / ODS) caps — POI analogy ---
/** Reject entries inflating more than 100:1 … (POI MinInflateRatio = 0.01). */
export const ZIP_MIN_INFLATE_RATIO = 0.01
/** … but only for entries over 100 KB uncompressed (POI GRACE_ENTRY_SIZE). */
export const ZIP_GRACE_ENTRY_BYTES = 100 * 1024
/** Cap on total uncompressed payload across all entries. */
export const ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
/** Cap on zip entry count. */
export const ZIP_MAX_ENTRIES = 10_000

/** Cap on extracted characters before rendering. */
export const MAX_EXTRACTED_CHARS = 5_000_000

/** PDF: cap on decoded image dimensions (unpdf recommendation). */
export const PDF_MAX_IMAGE_PIXELS = 16_000_000

/** Extraction wall-clock timeout. Note: PDF.js parses on the event loop, so
 *  this can't preempt synchronous work — it bounds awaits, not CPU spins. */
export const EXTRACTION_TIMEOUT_MS = 60_000

// --- Context-budget caps (claude-code parity) ---
/** At most 20 pages/slides/… per read_document call. */
export const MAX_UNITS_PER_CALL = 20
/** @file inlines documents of ≤ 10 units; larger get outline + pointer. */
export const AT_FILE_INLINE_MAX_UNITS = 10
/** Markdown output per call stays under 50 KB; overflow gets a continuation pointer. */
export const MAX_OUTPUT_CHARS = 50 * 1024

export class LimitExceeded extends Error {
	constructor(
		readonly limit: string,
		message: string,
	) {
		super(message)
		this.name = "LimitExceeded"
	}
}
