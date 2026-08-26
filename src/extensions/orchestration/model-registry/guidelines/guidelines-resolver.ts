import type { PromptMode } from "../../../prompt-construction/system-prompt.js"
import type { ModelRole, ModelRoles } from "../../model-roles.js"
import { orchestratorShouldReceiveRoleGuidelines } from "../../orchestrator-roles.js"
import type { ModelRegistry } from "../index.js"
import { DEFAULT_ORCHESTRATION_GUIDELINES } from "./default-orchestration-guidelines.js"
import { DEFAULT_ROLE_GUIDELINES } from "./default-role-guidelines.js"

// ---------------------------------------------------------------------------
// Role Guidelines
// ---------------------------------------------------------------------------

export function resolveRoleGuideline(role: ModelRole, modelId: string | undefined, registry?: ModelRegistry): string {
	const descriptor = modelId ? registry?.getModelById(modelId) : undefined
	return descriptor?.capabilities.guidelines?.[role] ?? DEFAULT_ROLE_GUIDELINES[role]
}

export function buildRoleGuidelinesSection(
	modelId: string | undefined,
	role: ModelRole | undefined,
	registry?: ModelRegistry,
	options?: { mode?: PromptMode; roles?: ModelRoles },
): string {
	if (!role) return ""
	if (options?.mode === "orchestrator") {
		if (!orchestratorShouldReceiveRoleGuidelines(role, modelId, options.roles)) {
			return ""
		}
	}
	const guideline = resolveRoleGuideline(role, modelId, registry)
	if (!guideline) return ""
	return `## Role Guidelines (${role})\n\n${guideline}`
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
