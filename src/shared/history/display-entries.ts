/**
 * Display-entry tagging for compaction-aware rendering.
 *
 * The TUI transcript renders the full leaf path (the SessionManager's
 * `buildDisplayEntries()`), so pre-compaction history stays visible. This
 * module tags each entry with whether it sits before the latest compaction's
 * cut point — a pure utility for consumers that need the compaction boundary
 * (e.g. future windowed rendering or display grouping). Not currently wired
 * to a production consumer; the shipped eviction walks the leaf path
 * directly in the SessionManager patch.
 */

/** The entry subset the SessionManager exposes (structural, no upstream import needed). */
export interface PathEntry {
	id: string
	parentId?: string | null
	type: string
	firstKeptEntryId?: string
}

export interface TaggedDisplayEntry<E extends PathEntry = PathEntry> {
	entry: E
	/** True when this entry was summarized away by the latest compaction (display-only; excluded from model context). */
	compactedBefore: boolean
}

/**
 * Tag a full display path (as returned by buildDisplayEntries) with
 * `compactedBefore`. Entries from the start of the path up to (but not
 * including) the latest compaction's `firstKeptEntryId` are marked; the
 * compaction entry itself and everything after are not.
 */
export function tagDisplayEntries<E extends PathEntry>(path: E[]): TaggedDisplayEntry<E>[] {
	let compactionIndex = -1
	for (let i = path.length - 1; i >= 0; i--) {
		if (path[i].type === "compaction") {
			compactionIndex = i
			break
		}
	}
	if (compactionIndex === -1) {
		return path.map((entry) => ({ entry, compactedBefore: false }))
	}
	const firstKeptId = path[compactionIndex].firstKeptEntryId
	const firstKeptIndex = firstKeptId ? path.findIndex((e) => e.id === firstKeptId) : -1
	const cutIndex = firstKeptIndex === -1 ? compactionIndex : firstKeptIndex
	return path.map((entry, i) => ({ entry, compactedBefore: i < cutIndex }))
}
