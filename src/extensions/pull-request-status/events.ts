import type { BranchPullRequest } from "./branch-status.js"

export const BRANCH_PR_OBSERVED_EVENT = "kimchi:branch-pr-observed"

export interface BranchPRObservation extends Partial<BranchPullRequest> {
	sessionId: string
	cwd: string
}
