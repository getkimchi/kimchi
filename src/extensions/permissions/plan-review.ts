export interface PlanReviewResult {
	approved: boolean
	issues: string[]
	simple: boolean
}

/**
 * Returns true if the plan is considered "simple" and should bypass
 * the full review gate. Simple means: very short, barely structured,
 * and clearly a single-file or single-step change.
 */
export function isSimplePlan(planText: string): boolean {
	const trimmed = planText.trim()
	if (trimmed.length === 0) return false

	const lines = trimmed.split("\n")

	// Plans with structured sections are *not* simple even if short
	const hasStructuredSections =
		/^##\s+Goal/im.test(trimmed) || /^##\s+Verification/im.test(trimmed) || /Accept\s+(When|ance)/i.test(trimmed)

	if (hasStructuredSections) return false

	// Count ## Chunk headers
	const chunkHeaderCount = lines.filter((l) => /^##\s+Chunk\b/i.test(l)).length
	if (chunkHeaderCount === 1 && lines.length <= 5) return true

	// Very short, unformatted plan
	if (lines.length <= 5) return true

	return false
}

export function reviewPlan(planText: string): PlanReviewResult {
	if (isSimplePlan(planText)) {
		return { approved: true, issues: [], simple: true }
	}

	const issues: string[] = []
	const lines = planText.split("\n")

	// Check: has Goal section (multiline regex so it can appear anywhere)
	if (!/^##\s+Goal/im.test(planText) && !/^##\s+Goals/im.test(planText)) {
		issues.push("Missing ## Goal section")
	}

	// Check: has at least one chunk or work-item section
	const chunkPattern = /^##\s+Chunk\b/i
	const workItemPattern = /^(##|###)\s+(Step|Phase|Task|Chunk|\d+)[\s.-:)]/i
	const hasChunk = lines.some((l) => chunkPattern.test(l.trim()))
	const hasWorkItem = lines.some((l) => workItemPattern.test(l.trim()))
	if (!hasChunk && !hasWorkItem) {
		issues.push("Missing ## Chunk or work-item section (### Step / ## Phase / etc.)")
	}

	// Check: has Verification section
	if (!/^##\s+Verification/im.test(planText)) {
		issues.push("Missing ## Verification section")
	}

	// Check: has Accept When / Acceptance criteria
	const hasAcceptCriteria = lines.some((l) => /Accept\s+When/i.test(l) || /Acceptance\s+Criteria?/i.test(l))
	if (!hasAcceptCriteria) {
		issues.push("Missing Accept When criteria in at least one chunk")
	}

	// Check: plan text is non-empty
	if (planText.trim().length === 0) {
		issues.push("Plan text is empty")
	}

	return { approved: issues.length === 0, issues, simple: false }
}
