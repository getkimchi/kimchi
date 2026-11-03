/**
 * Post-compaction steer survival check, shared by behaviours
 * (extensions/behaviours/wiring.ts) and skill auto-load
 * (extensions/skills-manager/auto-load.ts).
 *
 * Compaction retains a recent window of the session branch verbatim: a steer
 * message inside that window survives the rewrite, and re-steering it would
 * duplicate the body in every subsequent request until the next compaction.
 * The `session_compact` event fires after the compaction entry is committed
 * and carries it (`firstKeptEntryId`), so the post-rewrite branch tells us
 * exactly which steers are still in context; steers outside the kept region
 * were folded into the summary and must be re-steered to stay actionable.
 */

/** A session-branch entry carrying a steer body of the given customType. */
export function isSteerEntry(entry: unknown, customType: string): entry is { details: { name: string } } {
	if (!entry || typeof entry !== "object") return false
	const record = entry as { type?: unknown; customType?: unknown; details?: unknown }
	if (record.type !== "custom_message" || record.customType !== customType) return false
	return typeof (record.details as { name?: unknown } | undefined)?.name === "string"
}

/** Names whose steer entry of `customType` is still in the post-compaction
 *  context — i.e. inside the keep-recent window the rewrite retained
 *  verbatim. Undefined when the compaction entry or the session branch
 *  cannot be read (synthetic events, exotic session managers): callers fall
 *  back to re-steering, preserving the delivery guarantee over the dedup.
 *
 *  `customType` preserves each consumer's original filter exactly;
 *  behaviours pass their BEHAVIOUR_BODY_TYPE, skill auto-load passes its own
 *  body type. */
export function survivingSteerNames(
	event: { compactionEntry?: { id?: string; firstKeptEntryId?: string } },
	ctx: { sessionManager?: { getBranch?: () => unknown[] } } | undefined,
	customType: string,
): Set<string> | undefined {
	const compaction = event?.compactionEntry
	const branch = ctx?.sessionManager?.getBranch?.()
	if (!compaction || !Array.isArray(branch)) return undefined
	const cutId = compaction.firstKeptEntryId ?? compaction.id
	const cutIndex = branch.findIndex((entry) => (entry as { id?: string }).id === cutId)
	if (cutIndex < 0) return undefined
	const names = new Set<string>()
	for (const entry of branch.slice(cutIndex)) {
		if (isSteerEntry(entry, customType)) names.add(entry.details.name)
	}
	return names
}
