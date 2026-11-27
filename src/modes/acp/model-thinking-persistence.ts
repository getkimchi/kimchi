import type { readModelEffortDefaults } from "../../config.js"

/**
 * ACP-local Model Thinking names for the shared persistence APIs. These are
 * aliases only: the established config keys and session entry types retain
 * their serialized Effort spellings for compatibility with existing data.
 */
export type ModelThinkingDefaults = ReturnType<typeof readModelEffortDefaults>
export {
	readModelEffortDefaults as readModelThinkingDefaults,
	writeModelEffortDefault as writeModelThinkingDefault,
} from "../../config.js"
export {
	getModelEffortDefault as getModelThinkingDefault,
	MODEL_EFFORT_SELECTION_ENTRY_TYPE as MODEL_THINKING_SELECTION_ENTRY_TYPE,
	parseModelThinkingLevel,
	readSessionEffortSelections as readSessionThinkingSelections,
} from "../../model-effort.js"
