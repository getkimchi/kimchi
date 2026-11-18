/**
 * The canonical inline `[Image #N]` marker format shared by the prompt
 * editor (atomic delete/jump, marker-set sync) and the clipboard-image
 * extension (build/parse/strip at submit). One module owns the grammar so
 * the two sides can never drift apart.
 *
 * Distinct from `parseImageReferences` in image-registry.ts, which is a
 * deliberately lenient reader (`[Image   #N]`, any whitespace) for prose
 * references; markers the editor renders are always the canonical form below.
 */

const MARKER_RE = /\[Image #(\d+)\]/g
const TRAILING_MARKER_RE = /\[Image #(\d+)\]$/
const LEADING_MARKER_RE = /^\[Image #(\d+)\]/

/** Render the canonical `[Image #N]` marker for an id. */
export function buildImageMarker(id: number): string {
	return `[Image #${id}]`
}

/** All marker ids present in `text`, deduped. */
export function parseImageMarkers(text: string): Set<number> {
	const ids = new Set<number>()
	for (const m of text.matchAll(MARKER_RE)) ids.add(Number(m[1]))
	return ids
}

/** Remove the markers for `ids` from `text` (one trailing space each). */
export function stripImageMarkers(text: string, ids: number[]): string {
	if (ids.length === 0) return text
	const re = new RegExp(`\\[Image #(?:${ids.join("|")})\\] ?`, "g")
	return text.replace(re, "")
}

/**
 * The full marker anchored at the end of `beforeCursor` (the marker a
 * backspace would delete), or null.
 */
export function trailingImageMarker(beforeCursor: string): string | null {
	return beforeCursor.match(TRAILING_MARKER_RE)?.[0] ?? null
}

/**
 * The full marker anchored at the start of `afterCursor` (the marker a
 * forward-delete or right-arrow sits against), or null.
 */
export function leadingImageMarker(afterCursor: string): string | null {
	return afterCursor.match(LEADING_MARKER_RE)?.[0] ?? null
}
