import type { ModelRegistry } from "../index.js"
import type { Phase } from "../types.js"
import { DEFAULT_ORCHESTRATION_GUIDELINES } from "./default-orchestration-guidelines.js"
import { DEFAULT_PHASE_GUIDELINES } from "./default-phase-guidelines.js"

// ---------------------------------------------------------------------------
// Phase Guidelines
// ---------------------------------------------------------------------------

export function resolvePhaseGuideline(phase: Phase, modelId: string | undefined, registry?: ModelRegistry): string {
	const descriptor = modelId ? registry?.getModelById(modelId) : undefined
	return descriptor?.capabilities.guidelines?.[phase] ?? DEFAULT_PHASE_GUIDELINES[phase]
}

export function buildPhaseGuidelinesSection(
	modelId: string | undefined,
	phase: Phase | undefined,
	registry?: ModelRegistry,
): string {
	if (!phase) return ""
	const guideline = resolvePhaseGuideline(phase, modelId, registry)
	if (!guideline) return ""
	return `## Phase Guidelines (${phase})\n\n${guideline}`
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
