import type { ModelRegistry } from "../index.js"
import { DEFAULT_ORCHESTRATION_GUIDELINES } from "./default-orchestration-guidelines.js"

// ---------------------------------------------------------------------------
// Orchestration Guidelines
// ---------------------------------------------------------------------------

export function resolveOrchestrationGuideline(modelId: string | undefined, registry?: ModelRegistry): string {
	const descriptor = modelId ? registry?.getModelById(modelId) : undefined
	return descriptor?.capabilities.orchestrationGuidelines ?? DEFAULT_ORCHESTRATION_GUIDELINES
}

export function buildOrchestrationGuidelinesSection(modelId: string | undefined, registry?: ModelRegistry): string {
	const guideline = resolveOrchestrationGuideline(modelId, registry)
	if (!guideline) return ""
	return `### Orchestration Guidelines\n\n${guideline}`
}
