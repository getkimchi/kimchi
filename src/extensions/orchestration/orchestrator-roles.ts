/**
 * Helpers for resolving which delegable roles an orchestrator model owns.
 */

import type { ModelRole, ModelRoles, RoleModelAssignment } from "./model-roles.js"
import { modelIdFromRef, normalizeRoleModels } from "./model-roles.js"

export const ROLE_DELEGABLE: Record<ModelRole, keyof Omit<ModelRoles, "orchestrator" | "judge">> = {
	explore: "explorer",
	research: "researcher",
	plan: "planner",
	build: "builder",
	review: "reviewer",
}

/**
 * Canonical role order for prompt assembly. Derived from `ROLE_DELEGABLE`
 * so a newly added `ModelRole` cannot be silently omitted: the `Record<ModelRole, …>`
 * above fails to typecheck until the new member is present here too.
 */
export const ROLE_ORDER: readonly ModelRole[] = Object.keys(ROLE_DELEGABLE) as ModelRole[]

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
 * Worker role guidelines apply to the orchestrator only when it may perform
 * that role's work itself per Orchestration. Build is always delegated; review
 * guidance applies when the orchestrator also owns the reviewer role because
 * trivial, low-risk changes may be self-reviewed.
 */
export function orchestratorShouldReceiveRoleGuidelines(
	role: ModelRole,
	currentModelId: string | undefined,
	roles?: ModelRoles,
): boolean {
	if (!roles || !currentModelId) return false
	if (role === "build") return false
	const needed = ROLE_DELEGABLE[role]
	return resolveModelRoleNames(currentModelId, roles).includes(needed)
}

/**
 * Determine whether plan drafting should be delegated to a Plan agent.
 *
 * Planning is delegated when the orchestrator model is NOT the planner model —
 * i.e. a separate planner model is configured. When the orchestrator IS the
 * planner (same model assigned to both roles), the orchestrator writes plans
 * directly and no Plan agent is spawned.
 *
 * This replaces the ambiguous "decide whether to write the plan yourself or
 * delegate" instruction — the code decides based on role configuration.
 */
export function shouldDelegatePlanning(currentModelId: string | undefined, roles?: ModelRoles): boolean {
	if (!roles || !currentModelId) return false
	return !resolveModelRoleNames(currentModelId, roles).includes("planner")
}

/**
 * Determine whether review should be delegated to a Reviewer agent.
 *
 * Review is delegated when the orchestrator model is NOT a reviewer model —
 * i.e. a separate reviewer model is configured. When the orchestrator IS a
 * reviewer, it may self-review for trivial and low-risk changes per
 * Orchestration phase responsibilities.
 */
export function shouldDelegateReview(currentModelId: string | undefined, roles?: ModelRoles): boolean {
	if (!roles || !currentModelId) return false
	return !resolveModelRoleNames(currentModelId, roles).includes("reviewer")
}
