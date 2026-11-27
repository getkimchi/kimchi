import type { ModelThinkingLevel as ModelEffortLevel } from "@earendil-works/pi-ai"
import { readModelEffortDefaults } from "./config.js"
import { CANONICAL_THINKING_LEVELS } from "./thinking-levels.js"

export const MODEL_EFFORT_SELECTION_ENTRY_TYPE = "model_effort_selection"

const CANONICAL_LEVELS = new Set<string>(CANONICAL_THINKING_LEVELS)

export function parseModelEffortLevel(value: unknown): ModelEffortLevel | undefined {
	return typeof value === "string" && CANONICAL_LEVELS.has(value) ? (value as ModelEffortLevel) : undefined
}

export function getModelEffortDefault(modelId: string, configPath?: string): ModelEffortLevel | undefined {
	// Keep first-use reads live so defaults written by other CLI processes are visible.
	return parseModelEffortLevel(readModelEffortDefaults(configPath)[modelId])
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Rebuild one session's concrete-model selections from durable custom entries. */
export function readSessionEffortSelections(entries: readonly unknown[]): Map<string, ModelEffortLevel> {
	const selections = new Map<string, ModelEffortLevel>()
	for (const entry of entries) {
		const record = recordOf(entry)
		if (record?.type !== "custom" || record.customType !== MODEL_EFFORT_SELECTION_ENTRY_TYPE) continue
		const data = recordOf(record.data)
		const effort = parseModelEffortLevel(data?.value)
		if (typeof data?.modelId !== "string" || data.modelId.length === 0 || !effort) continue
		selections.set(data.modelId, effort)
	}
	return selections
}
