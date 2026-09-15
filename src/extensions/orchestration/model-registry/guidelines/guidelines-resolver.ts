import type { ModelRegistry } from "../index.js"
import type { ModelRole } from "../types.js"
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
): string {
	if (!role) return ""
	const guideline = resolveRoleGuideline(role, modelId, registry)
	if (!guideline) return ""
	return `## Role Guidelines (${role})\n\n${guideline}`
}
