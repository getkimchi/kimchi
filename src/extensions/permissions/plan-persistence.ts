/**
 * Thin backwards-compat wrapper around `AdhocPlanStore.save()`. Kept so that
 * any external caller (tests, scripts, other extensions) that imports
 * `saveApprovedPlan` from this path continues to work after the Phase 4
 * migration. New code should use `AdhocPlanStore` directly.
 */
import { AdhocPlanStore } from "../../shared/planning/plan-artifact-store.js"

export function saveApprovedPlan(cwd: string, planText: string): string {
	const ref = new AdhocPlanStore().saveSync({ planText }, { cwd })
	return ref.path
}
