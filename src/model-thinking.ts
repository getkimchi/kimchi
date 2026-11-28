import type { ModelThinkingLevel } from "@earendil-works/pi-ai"
import { readModelThinkingLevelDefaults } from "./config.js"
import { CANONICAL_THINKING_LEVELS } from "./thinking-levels.js"

export const MODEL_THINKING_SELECTION_ENTRY_TYPE = "model_effort_selection"

const CANONICAL_LEVELS = new Set<string>(CANONICAL_THINKING_LEVELS)

export function parseModelThinkingLevel(value: unknown): ModelThinkingLevel | undefined {
	return typeof value === "string" && CANONICAL_LEVELS.has(value) ? (value as ModelThinkingLevel) : undefined
}

export function getModelThinkingLevelDefault(modelId: string, configPath?: string): ModelThinkingLevel | undefined {
	// Keep first-use reads live so defaults written by other CLI processes are visible.
	return parseModelThinkingLevel(readModelThinkingLevelDefaults(configPath)[modelId])
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Rebuild one session's concrete-model selections from durable custom entries. */
export function readSessionThinkingSelections(entries: readonly unknown[]): Map<string, ModelThinkingLevel> {
	const selections = new Map<string, ModelThinkingLevel>()
	for (const entry of entries) {
		const record = recordOf(entry)
		if (record?.type !== "custom" || record.customType !== MODEL_THINKING_SELECTION_ENTRY_TYPE) continue
		const data = recordOf(record.data)
		const thinkingLevel = parseModelThinkingLevel(data?.value)
		if (typeof data?.modelId !== "string" || data.modelId.length === 0 || !thinkingLevel) continue
		selections.set(data.modelId, thinkingLevel)
	}
	return selections
}
