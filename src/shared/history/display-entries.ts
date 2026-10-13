/**
 * Display-entry tagging (compaction-history plan, D1).
 *
 * The TUI transcript renders the full leaf path (SessionManager's patched
 * `buildDisplayEntries()`), so pre-compaction history stays visible. This
 * module tags each entry with whether it sits before the latest compaction's
 * cut point — the signal later chunks use for windowing (D2) and content
 * eviction (D3). Pure; unit-testable against any entry path.
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
