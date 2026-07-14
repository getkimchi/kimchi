/**
 * Helpers for resolving which delegable roles an orchestrator model owns.
 */

import type { Phase } from "./model-registry/types.js"
import type { ModelRoles, RoleModelAssignment } from "./model-roles.js"
import { modelIdFromRef, normalizeRoleModels } from "./model-roles.js"

const PHASE_DELEGABLE_ROLE: Record<Phase, keyof Omit<ModelRoles, "orchestrator" | "judge">> = {
	explore: "explorer",
	research: "researcher",
	plan: "planner",
	build: "builder",
	review: "reviewer",
}

function matchesRef(candidate: string, refs: string[]): boolean {
	return refs.some((r) => r === candidate || modelIdFromRef(r) === candidate)
}

/** Roles assigned to a model ref in the current multi-model configuration. */
export function resolveModelRoleNames(ref: string, roles?: ModelRoles): string[] {
	if (!roles) return []
	const assigned: string[] = []
	const roleMap: Record<string, RoleModelAssignment> = {
		planner: roles.planner,
		builder: roles.builder,
		reviewer: roles.reviewer,
		explorer: roles.explorer,
		researcher: roles.researcher,
	}
	for (const [roleName, assignment] of Object.entries(roleMap)) {
		if (matchesRef(ref, normalizeRoleModels(assignment))) {
			assigned.push(roleName)
		}
	}
	if (roles.orchestrator === ref || modelIdFromRef(roles.orchestrator) === ref) {
		assigned.unshift("orchestrator")
	}
	return assigned
}

/**
 * Worker phase guidelines apply to the orchestrator only when it may perform
 * that phase itself per Orchestration. Build and review are always delegated.
 */
export function orchestratorShouldReceivePhaseGuidelines(
	phase: Phase,
	currentModelId: string | undefined,
	roles?: ModelRoles,
): boolean {
	if (!roles || !currentModelId) return false
	if (phase === "build" || phase === "review") return false
	const needed = PHASE_DELEGABLE_ROLE[phase]
	return resolveModelRoleNames(currentModelId, roles).includes(needed)
}
