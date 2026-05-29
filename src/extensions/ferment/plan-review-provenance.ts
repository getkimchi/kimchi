/**
 * Plan-review provenance tokens.
 *
 * Closes the honor-system hole: structured output only proves the Plan Reviewer
 * subagent returned a verdict via its bound tool — it does NOT prove the planner
 * actually spawned a reviewer. The planner copies the verdict JSON verbatim into
 * `propose_ferment_scoping.plan_review`, so a planner could fabricate an
 * `{status:"approved",required_changes:[]}` object with zero subagent spawns and
 * pass shape validation.
 *
 * Mechanism: `submit_plan_review` mints a token here whenever a real verdict is
 * captured, and stamps it into the verdict object the subagent returns. The
 * planner carries it through verbatim. `propose_ferment_scoping` then verifies the
 * token was issued this session before accepting the review. A fabricated
 * plan_review has no valid token and is rejected.
 *
 * Same-process only (matches the AsyncLocalStorage capture seam): the subagent and
 * the planner share this module-global set within one CLI session. Tokens are
 * in-memory; a CLI restart between the reviewer spawn and the proposal invalidates
 * the token, and the planner is told to re-run the reviewer.
 *
 * Verify-only (no consume): a token stays valid for the session so the planner can
 * retry `propose_ferment_scoping` after an unrelated failure (e.g. malformed gates)
 * without re-spawning the reviewer. This proves a reviewer ran this session, not
 * that the verdict matches the exact current plan bytes — strictly stronger than
 * the prior "anything goes" contract.
 */

import { randomUUID } from "node:crypto"

/** Field name carrying the provenance token inside a plan_review payload. */
export const PLAN_REVIEW_PROVENANCE_FIELD = "_provenance"

/** Soft cap so a very long session can't grow the set without bound. */
const MAX_TOKENS = 512

const issuedTokens = new Set<string>()

/** Mint a provenance token for a freshly captured Plan Reviewer verdict. */
export function issuePlanReviewToken(): string {
	if (issuedTokens.size >= MAX_TOKENS) {
		// Drop the oldest (insertion-ordered) token to keep the set bounded.
		const oldest = issuedTokens.values().next().value
		if (oldest !== undefined) issuedTokens.delete(oldest)
	}
	const token = randomUUID()
	issuedTokens.add(token)
	return token
}

/** True if `token` was issued by issuePlanReviewToken this session. */
export function verifyPlanReviewToken(token: unknown): boolean {
	return typeof token === "string" && issuedTokens.has(token)
}

/** Test-only: clear all issued tokens. */
export function __resetPlanReviewTokensForTest(): void {
	issuedTokens.clear()
}
