import { truncateToWidth as upstreamTruncateToWidth } from "@earendil-works/pi-tui"

// A selector viewport can truncate several columns per row at a few widths.
// Keep enough recent rows for those paints without retaining session history.
const TRUNCATION_CACHE_LIMIT = 128
const truncationCache = new Map<string, string>()

/**
 * Memoize the pure upstream truncation operation for repeated component paints.
 * Every upstream parameter is represented in the key; String(maxWidth) also
 * distinguishes NaN and infinities (0 and -0 are equivalent to the upstream).
 */
export function truncateLineToWidth(text: string, maxWidth: number, ellipsis = "...", pad = false): string {
	const key = `${String(maxWidth)}:${ellipsis.length}:${text.length}:${pad ? 1 : 0}:${ellipsis}${text}`
	const cached = truncationCache.get(key)
	if (cached !== undefined) {
		// Map insertion order provides a small LRU without another data structure.
		truncationCache.delete(key)
		truncationCache.set(key, cached)
		return cached
	}

	const result = upstreamTruncateToWidth(text, maxWidth, ellipsis, pad)
	truncationCache.set(key, result)
	if (truncationCache.size > TRUNCATION_CACHE_LIMIT) {
		const oldest = truncationCache.keys().next().value
		if (oldest !== undefined) truncationCache.delete(oldest)
	}
	return result
}

/** Test-only isolation for call-count and eviction probes. */
export function resetTruncateToWidthCacheForTests(): void {
	truncationCache.clear()
}

/**
 * Hard-truncate every rendered line to the terminal width.
 *
 * pi-tui crashes when a custom component emits a line wider than the
 * terminal, so every custom renderer must pass its final output through
 * truncation instead of open-coding
 * `lines.map((line) => truncateToWidth(line, width))`.
 */
export function truncateLinesToWidth(lines: string[], width: number): string[] {
	return lines.map((line) => truncateLineToWidth(line, width))
}
