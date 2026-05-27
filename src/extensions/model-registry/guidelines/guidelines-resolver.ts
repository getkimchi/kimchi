import type { ModelRegistry } from "../index.js"
import { DEFAULT_ORCHESTRATION_GUIDELINES } from "./default-orchestration-guidelines.js"

export function resolveModelGuideline(modelId: string | undefined, registry?: ModelRegistry): string {
	const descriptor = modelId ? registry?.getModelById(modelId) : undefined
	return descriptor?.capabilities.modelGuidelines ?? DEFAULT_ORCHESTRATION_GUIDELINES
}

export function buildModelGuidelinesSection(modelId: string | undefined, registry?: ModelRegistry): string {
	const guideline = resolveModelGuideline(modelId, registry)
	if (!guideline) return ""
	return `### Model Guidelines\n\n${guideline}`
}
