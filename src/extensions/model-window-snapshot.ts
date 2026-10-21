import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"

export const MODEL_WINDOW_SNAPSHOT_ENTRY = "kimchi_model_window_snapshot"

/**
 * Persisted at every compaction: the context window of the model whose window
 * governed the compaction threshold. A model object can carry a window that
 * does not match what the backend actually serves (e.g. the routed-capability
 * sync painting a model selected mid-flight); without this entry the mismatch
 * is invisible — compaction quietly fires on the wrong number.
 */
interface PersistedModelWindowSnapshot {
	version: 1
	provider: string
	modelId: string
	contextWindow: number
	maxTokens: number
	timestamp: number
}

type ModelWindowSnapshotEntry = Extract<SessionEntry, { type: "custom" }> & {
	data: PersistedModelWindowSnapshot
}

function isPersistedModelWindowSnapshot(data: unknown): data is PersistedModelWindowSnapshot {
	if (data === null || typeof data !== "object") return false
	const d = data as Record<string, unknown>
	return (
		d.version === 1 &&
		typeof d.provider === "string" &&
		typeof d.modelId === "string" &&
		typeof d.contextWindow === "number" &&
		typeof d.maxTokens === "number" &&
		typeof d.timestamp === "number"
	)
}

export function isModelWindowSnapshotEntry(entry: SessionEntry): entry is ModelWindowSnapshotEntry {
	return (
		entry.type === "custom" &&
		entry.customType === MODEL_WINDOW_SNAPSHOT_ENTRY &&
		isPersistedModelWindowSnapshot(entry.data)
	)
}

function formatWindowSnapshot(data: PersistedModelWindowSnapshot): string {
	return `Context window ${data.contextWindow.toLocaleString()} tokens (max output ${data.maxTokens.toLocaleString()}) — ${data.provider}/${data.modelId}`
}

/**
 * Records the effective model window at every compaction. Custom entries stay
 * out of LLM context but render in the transcript, so the number that governed
 * the threshold is visible on resume (same pattern as the auto-model
 * routed-pick notice).
 */
export default function modelWindowSnapshotExtension(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(MODEL_WINDOW_SNAPSHOT_ENTRY, (entry, _options, theme) => {
		if (!isModelWindowSnapshotEntry(entry)) return undefined
		return new Text(theme.fg("dim", formatWindowSnapshot(entry.data)), 0, 0)
	})

	pi.on("session_compact", (_event, ctx) => {
		const model = ctx.model
		if (!model) return
		pi.appendEntry(MODEL_WINDOW_SNAPSHOT_ENTRY, {
			version: 1,
			provider: model.provider,
			modelId: model.id,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			timestamp: Date.now(),
		} satisfies PersistedModelWindowSnapshot)
	})
}
