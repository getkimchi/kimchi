/**
 * History residency — kimchi-side surface.
 *
 * The eviction itself lives in the pi patch (SessionManager
 * `appendCompaction` → `__kimchiEvictCompactedEntries`): after a compaction
 * commits, pre-cut message entries' in-memory content is replaced with a
 * `[kimchi-ext:log]` marker resolved on demand by `sessionEntryToContextMessages`
 * (bounded LRU). The session log stays the durable source of truth.
 *
 * This module exposes the marker contract for kimchi consumers (display,
 * stats) and documents the knob.
 */
export const KIMCHI_LOG_MARKER_PREFIX = "[kimchi-ext:log]"

export interface LogMarkerHandle {
	file: string
	offset: number
	length: number
}

/** Parse a log marker; undefined for any other text. */
export function parseLogMarker(text: string): LogMarkerHandle | undefined {
	if (!text.startsWith(KIMCHI_LOG_MARKER_PREFIX)) return undefined
	try {
		const parsed = JSON.parse(text.slice(KIMCHI_LOG_MARKER_PREFIX.length)) as Partial<LogMarkerHandle>
		const { file, offset, length } = parsed
		if (typeof file !== "string" || typeof offset !== "number" || typeof length !== "number") return undefined
		if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) return undefined
		return { file, offset, length }
	} catch {
		return undefined
	}
}

/** True when a message entry's content has been evicted to the log. */
export function isEvictedContent(content: unknown): boolean {
	if (!Array.isArray(content) || content.length !== 1) return false
	const block = content[0] as { type?: string; text?: unknown } | null
	return (
		typeof block === "object" &&
		block !== null &&
		block.type === "text" &&
		typeof block.text === "string" &&
		block.text.startsWith(KIMCHI_LOG_MARKER_PREFIX)
	)
}
