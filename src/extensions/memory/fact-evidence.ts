import { basename, join } from "node:path"
import { defaultMemoryDir } from "./backend.js"
import { listRecallFiles, readTraceEvents, type TraceEvent, tracesDir, traceTextHash } from "./trace.js"

export interface FactRecallEvidence {
	recallId: string
	sourceFile: string
	timestamp: string
	kind: string
	trigger?: string
	conclusion?: string
	scheduledStep?: string
	selected: boolean
	delivered: boolean
	/** Text-only compatibility is evidence, not a verified fact-ID link. */
	identity: "fact-id" | "legacy-text" | "recall-context"
}

type EvidenceIdentity = FactRecallEvidence["identity"]

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined
}

function selectedIds(event: TraceEvent, field: "selectedIds" | "injectedIds"): Set<string> {
	return new Set(strings(event[field]))
}

function matchingLegacyText(
	event: TraceEvent,
	field: "selected" | "injected",
	hash: string,
	factText: string,
): boolean {
	return strings(event[field]).some((item) => item === hash || item === factText)
}

function hitIds(event: TraceEvent): Array<{ id: string; store?: string }> {
	return Array.isArray(event.hits)
		? event.hits.flatMap((hit) => {
				if (!hit || typeof hit !== "object") return []
				const record = hit as { id?: unknown; factId?: unknown; store?: unknown }
				const id = record.factId ?? record.id
				if (typeof id !== "string") return []
				return [{ id, ...(typeof record.store === "string" ? { store: record.store } : {}) }]
			})
		: []
}

/** Read compact recall logs without exposing prompts, fact text or trace paths
 * to the caller. Legacy hashes are explicitly distinguished from stable IDs.
 * A recall group's final delivery fields apply only after evidence that this
 * fact participated in that same recall.
 */
export function readFactRecallEvidence(
	fact: { id: string; memory: string },
	options: { root?: string; limit?: number } = {},
): FactRecallEvidence[] {
	const root = options.root ?? defaultMemoryDir()
	const limit = Math.max(1, Math.min(32, Math.floor(options.limit ?? 8)))
	const hash = traceTextHash(fact.memory)
	const groups = new Map<string, FactRecallEvidence>()
	const files = listRecallFiles(root)
	for (const name of files.slice(-64).reverse()) {
		const sourceFile = join(tracesDir(root), name)
		for (const event of readTraceEvents(sourceFile)) {
			if (event.type !== "recall") continue
			const recallId = text(event.recall_id) ?? basename(name, ".jsonl")
			// One logical delivery may span emitters and partitions. Merge it once,
			// rather than treating selection and attachment as independent support.
			const key = recallId
			const selectedById = selectedIds(event, "selectedIds").has(fact.id)
			const injectedById = selectedIds(event, "injectedIds").has(fact.id)
			const selectedByText = matchingLegacyText(event, "selected", hash, fact.memory)
			const injectedByText = matchingLegacyText(event, "injected", hash, fact.memory)
			const seenAsHit = hitIds(event).some((hit) => hit.id === fact.id)
			if (!selectedById && !injectedById && !selectedByText && !injectedByText && !seenAsHit) continue
			const identity: EvidenceIdentity =
				selectedById || injectedById || seenAsHit
					? "fact-id"
					: selectedByText || injectedByText
						? "legacy-text"
						: "recall-context"
			const prior = groups.get(key)
			const timestamp = text(event.ts) ?? prior?.timestamp ?? ""
			const isLatest = !prior || timestamp >= prior.timestamp
			const conclusion = isLatest ? (text(event.conclusion) ?? prior?.conclusion) : prior?.conclusion
			const isDeliveryEvent =
				event.steered === true ||
				event.attachedToTurn === true ||
				conclusion === "steered" ||
				conclusion === "attachedToTurn"
			groups.set(key, {
				recallId,
				sourceFile: isLatest ? name : (prior?.sourceFile ?? name),
				timestamp: timestamp >= (prior?.timestamp ?? "") ? timestamp : (prior?.timestamp ?? ""),
				kind: text(event.kind) ?? prior?.kind ?? "unknown",
				...((text(event.trigger) ?? prior?.trigger) ? { trigger: text(event.trigger) ?? prior?.trigger } : {}),
				...(conclusion ? { conclusion } : {}),
				...((text(event.scheduledStep) ?? prior?.scheduledStep)
					? { scheduledStep: text(event.scheduledStep) ?? prior?.scheduledStep }
					: {}),
				selected: (prior?.selected ?? false) || selectedById || selectedByText,
				delivered: (prior?.delivered ?? false) || injectedById || injectedByText || isDeliveryEvent,
				identity: prior?.identity === "fact-id" ? "fact-id" : identity,
			})
		}
		if (groups.size >= limit * 4) break
	}
	return [...groups.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit)
}
