import type { BranchPullRequest } from "./branch-status.js"

export const BRANCH_PR_OBSERVED_EVENT = "kimchi:branch-pr-observed"

export interface BranchPRObservation extends Partial<BranchPullRequest> {
	sessionId: string
	cwd: string
}

/** A recorded commit of any session's work that has an open PR: a `WorkPullRequestUpdate` from PR discovery. */
export const WORK_PR_OBSERVED_EVENT = "kimchi:work-pr-observed"
