export interface ExportEntry {
	id: string
	parentId: string | null
	type: string
	customType?: string
	data?: unknown
	message?: unknown
	traceIds?: string[]
	[key: string]: unknown
}

/**
 * Walk the parent chain from `startId` until finding an entry with
 * `type === "message"` and `message.role === "assistant"`.  Returns the
 * found entry or null if the chain ends without a match.
 */
function findAssistantMessageEntry(
	entries: ExportEntry[],
	idToIndex: Map<string, number>,
	startId: string | null,
): ExportEntry | null {
	let currentId = startId
	const visited = new Set<string>()

	while (currentId != null && !visited.has(currentId)) {
		visited.add(currentId)
		const idx = idToIndex.get(currentId)
		if (idx === undefined) break

		const entry = entries[idx]
		if (entry.type === "message" && (entry.message as { role?: string } | undefined)?.role === "assistant") {
			return entry
		}
		currentId = entry.parentId
	}

	return null
}

/**
 * Post-process a raw entries array to inject `traceIds` from `trace_ids`
 * custom entries into the nearest assistant `message` entry in each
 * `trace_ids` entry's parent chain.  Intermediate entries (e.g.
 * `tool_result`) are skipped.  The `trace_ids` entries themselves are
 * kept for backward compatibility.
 */
export function injectTraceIdsIntoEntries(entries: ExportEntry[]): ExportEntry[] {
	if (entries.length === 0) return entries

	const idToIndex = new Map<string, number>()
	for (let i = 0; i < entries.length; i++) {
		idToIndex.set(entries[i].id, i)
	}

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "trace_ids") {
			const data = entry.data as { traceIds?: string[] } | undefined
			const traceIds = data?.traceIds
			if (!traceIds || traceIds.length === 0) continue
			if (entry.parentId == null) continue

			const target = findAssistantMessageEntry(entries, idToIndex, entry.parentId)
			if (!target) continue

			const existing = target.traceIds ?? []
			const merged = [...new Set([...existing, ...traceIds])]
			target.traceIds = merged
		}
	}

	return entries
}

/**
 * Post-process exported JSONL lines to inject `traceIds` from `trace_ids` custom
 * entries into their parent entries.  The `trace_ids` entries themselves are
 * kept for backward compatibility.
 */
export function injectTraceIdsIntoExport(lines: string[]): string[] {
	if (lines.length === 0) return lines
	const parsed = lines.map((l) => JSON.parse(l) as ExportEntry)
	injectTraceIdsIntoEntries(parsed)
	return parsed.map((p) => JSON.stringify(p))
}
