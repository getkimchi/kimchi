import type { ModelThinkingLevel } from "@earendil-works/pi-ai"
import { readModelEffortDefaults } from "./config.js"
import { CAPABILITIES_KEY } from "./modes/acp/capabilities.js"
import { CANONICAL_THINKING_LEVELS } from "./thinking-levels.js"

export const SESSION_APP_MODES = ["chat", "design", "code"] as const
export type SessionAppMode = (typeof SESSION_APP_MODES)[number]

export const MODEL_EFFORT_SELECTION_ENTRY_TYPE = "model_effort_selection"

const CANONICAL_LEVELS = new Set<string>(CANONICAL_THINKING_LEVELS)
const APP_MODES = new Set<string>(SESSION_APP_MODES)

export function parseModelThinkingLevel(value: unknown): ModelThinkingLevel | undefined {
	return typeof value === "string" && CANONICAL_LEVELS.has(value) ? (value as ModelThinkingLevel) : undefined
}

export function parseSessionAppMode(value: unknown): SessionAppMode | undefined {
	return typeof value === "string" && APP_MODES.has(value) ? (value as SessionAppMode) : undefined
}

/** Read the fixed Studio App-mode from session setup metadata. Other clients
 * omit it and retain the harness's existing model/effort fallback. */
export function sessionAppModeFromMeta(meta: unknown): SessionAppMode | undefined {
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined
	const kimchi = (meta as Record<string, unknown>)[CAPABILITIES_KEY]
	if (!kimchi || typeof kimchi !== "object" || Array.isArray(kimchi)) return undefined
	return parseSessionAppMode((kimchi as Record<string, unknown>).appMode)
}

export function getModelEffortDefault(
	appMode: SessionAppMode | undefined,
	modelId: string,
	configPath?: string,
): ModelThinkingLevel | undefined {
	if (!appMode) return undefined
	// Keep first-use reads live so defaults written by other CLI processes are visible.
	return parseModelThinkingLevel(readModelEffortDefaults(configPath)[appMode]?.[modelId])
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Rebuild one session's concrete-model selections from durable custom entries. */
export function readSessionEffortSelections(entries: readonly unknown[]): Map<string, ModelThinkingLevel> {
	const selections = new Map<string, ModelThinkingLevel>()
	for (const entry of entries) {
		const record = recordOf(entry)
		if (record?.type !== "custom" || record.customType !== MODEL_EFFORT_SELECTION_ENTRY_TYPE) continue
		const data = recordOf(record.data)
		const effort = parseModelThinkingLevel(data?.value)
		if (typeof data?.modelId !== "string" || data.modelId.length === 0 || !effort) continue
		selections.set(data.modelId, effort)
	}
	return selections
}
