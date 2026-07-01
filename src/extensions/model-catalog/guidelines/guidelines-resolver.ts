import type { ModelRegistry } from "../index.js"
import type { Phase } from "../types.js"
import { DEFAULT_ORCHESTRATION_GUIDELINES } from "./default-orchestration-guidelines.js"
import { DEFAULT_PHASE_GUIDELINES } from "./default-phase-guidelines.js"

const PHASE_ORDER: readonly Phase[] = ["explore", "research", "plan", "build", "review"]

const PHASE_SUBHEADING: Readonly<Record<Phase, string>> = {
	explore: "When you are exploring the codebase:",
	research: "When you are researching:",
	plan: "When you are planning:",
	build: "When you are building:",
	review: "When you are reviewing:",
}

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

/**
 * Build a combined `## Execution Guidelines` section that lists the resolved
 * guideline for every phase in order. Phases whose guideline resolves to an
 * empty/whitespace string are skipped. Returns an empty string if no phase
 * contributes any content.
 */
export function buildExecutionGuidelinesSection(modelId: string | undefined, registry?: ModelRegistry): string {
	const blocks: string[] = []
	for (const phase of PHASE_ORDER) {
		const guideline = resolvePhaseGuideline(phase, modelId, registry)
		if (!guideline || !guideline.trim()) continue
		blocks.push(`${PHASE_SUBHEADING[phase]}\n\n${guideline}`)
	}
	if (blocks.length === 0) return ""
	return `## Execution Guidelines\n\n${blocks.join("\n\n")}`
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
