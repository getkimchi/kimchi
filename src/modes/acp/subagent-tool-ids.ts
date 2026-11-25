const TOOL_ID_HISTORY_ENTRY = "kimchi:subagent-tool-id"

export interface ToolIdHistoryEntry {
	version: 1
	piToolCallId: string
	acpToolCallId: string
}

type PersistToolId = (entry: ToolIdHistoryEntry) => void

function isHistoryEntry(value: unknown): value is ToolIdHistoryEntry {
	if (!value || typeof value !== "object") return false
	const entry = value as Record<string, unknown>
	return (
		entry.version === 1 &&
		typeof entry.piToolCallId === "string" &&
		entry.piToolCallId.length > 0 &&
		typeof entry.acpToolCallId === "string" &&
		entry.acpToolCallId.length > 0
	)
}

/** Child-local ACP tool ID history. Live mappings are appended once; replay
 * consumes mappings in their durable branch order, including recycled Pi IDs.
 * Recovered histories never persist their own reconstruction. */
export class SubagentToolIdHistory {
	private readonly seen = new Map<string, string>()
	private readonly replayed = new Map<string, string[]>()
	private maximumSequence = -1

	constructor(private readonly persist?: PersistToolId) {}

	static fromEntries(entries: readonly unknown[]): SubagentToolIdHistory {
		const history = new SubagentToolIdHistory()
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue
			if (Reflect.get(entry, "type") !== "custom" || Reflect.get(entry, "customType") !== TOOL_ID_HISTORY_ENTRY)
				continue
			const data = Reflect.get(entry, "data")
			if (!isHistoryEntry(data)) continue
			const queue = history.replayed.get(data.piToolCallId) ?? []
			queue.push(data.acpToolCallId)
			history.replayed.set(data.piToolCallId, queue)
			history.recordSequence(data.acpToolCallId)
		}
		return history
	}

	record(piToolCallId: string, acpToolCallId: string): void {
		if (this.seen.get(piToolCallId) === acpToolCallId) return
		this.seen.set(piToolCallId, acpToolCallId)
		this.recordSequence(acpToolCallId)
		this.persist?.({ version: 1, piToolCallId, acpToolCallId })
	}

	takeForReplay(piToolCallId: string): string | undefined {
		const queue = this.replayed.get(piToolCallId)
		const acpId = queue?.shift()
		if (acpId !== undefined) this.recordSequence(acpId)
		return acpId
	}

	nextSequenceFloor(): number {
		return this.maximumSequence + 1
	}

	private recordSequence(acpToolCallId: string): void {
		const match = /^kt\.[^.]+\.(\d+)$/.exec(acpToolCallId)
		if (match) this.maximumSequence = Math.max(this.maximumSequence, Number(match[1]))
	}
}

export const SUBAGENT_TOOL_ID_ENTRY_TYPE = TOOL_ID_HISTORY_ENTRY
