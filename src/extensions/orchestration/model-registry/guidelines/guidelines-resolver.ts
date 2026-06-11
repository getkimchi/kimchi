import type { ModelRegistry } from "../index.js"
import type { Phase } from "../types.js"
import { DEFAULT_ORCHESTRATION_GUIDELINES } from "./default-orchestration-guidelines.js"

// ---------------------------------------------------------------------------
// Model Guidelines (per-phase, model-specific behavioral tweaks)
// ---------------------------------------------------------------------------

export function resolveModelGuideline(phase: Phase, modelId: string | undefined, registry?: ModelRegistry): string {
	const descriptor = modelId ? registry?.getModelById(modelId) : undefined
	return descriptor?.capabilities.guidelines?.[phase] ?? ""
}

export function buildModelGuidelinesSection(
	modelId: string | undefined,
	phase: Phase | undefined,
	registry?: ModelRegistry,
): string {
	if (!phase) return ""
	const guideline = resolveModelGuideline(phase, modelId, registry)
	if (!guideline) return ""
	return `## Model Guidelines\n\n${guideline}`
}

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
