import {
	calculatePullRequestCosts as calculate,
	type PullRequestCostReport,
	type RequestCostObservation,
} from "@getkimchi/kimchi-bridge/work/kimchi/costs"
import { sameWorkAccount, type WorkAccount } from "./scope.js"
import type { WorkRecord } from "./summary.js"

/**
 * What each request cost and which pull request it belongs to, by the bridge's calculator and this harness's rule
 * for when two accounts are the same. Billing rows must already be joined to the exact request and scoped to its
 * billing account.
 */
export function calculatePullRequestCosts(
	records: readonly WorkRecord[],
	observations: readonly RequestCostObservation[],
	incompleteRequestIds?: ReadonlySet<string>,
	noCharge?: ReadonlyMap<string, WorkAccount>,
): PullRequestCostReport {
	return calculate({ records, observations, sameAccount: sameWorkAccount, incompleteRequestIds, noCharge })
}
