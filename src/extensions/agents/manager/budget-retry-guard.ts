export interface BudgetRetryBlock {
	budget: number
	subagentType: string
	description: string
	prompt: string
	normalizedSubagentType: string
	normalizedDescription: string
	normalizedPrompt: string
}

export interface BudgetRetryAttempt {
	tokenBudget?: number
	subagentType: string
	description?: string
	prompt?: string
}

export type BudgetRetryCandidate = Pick<BudgetRetryBlock, "budget" | "subagentType" | "description" | "prompt">

function normalize(value: string | undefined): string {
	return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase()
}

export function createBudgetRetryBlock(input: {
	budget: number
	subagentType: string
	description: string
	prompt: string
}): BudgetRetryBlock {
	return {
		...input,
		normalizedSubagentType: normalize(input.subagentType),
		normalizedDescription: normalize(input.description),
		normalizedPrompt: normalize(input.prompt),
	}
}

export function shouldBlockBudgetRetry(block: BudgetRetryBlock | undefined, attempt: BudgetRetryAttempt): boolean {
	if (!block || attempt.tokenBudget == null || attempt.tokenBudget <= block.budget) return false
	if (normalize(attempt.subagentType) !== block.normalizedSubagentType) return false

	const description = normalize(attempt.description)
	const prompt = normalize(attempt.prompt)
	return (
		(description.length > 0 && description === block.normalizedDescription) ||
		(prompt.length > 0 && prompt === block.normalizedPrompt)
	)
}

export function createBudgetRetryBlockFromCompletion(
	candidate: BudgetRetryCandidate | undefined,
	record: { status: string; abortReason?: string },
): BudgetRetryBlock | undefined {
	if (!candidate) return undefined
	if (record.status !== "aborted" || record.abortReason !== "token_budget") return undefined
	return createBudgetRetryBlock(candidate)
}
