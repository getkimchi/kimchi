export interface AgentWorkerBudget {
	maxTurns: number
	maxDuration: number
	tokenBudget: number
}

/** Shared delegation budgets used by prompts and Ferment step handoffs. */
export const AGENT_WORKER_BUDGETS = {
	singleFile: { maxTurns: 12, maxDuration: 300, tokenBudget: 50_000 },
	multiFile: { maxTurns: 30, maxDuration: 600, tokenBudget: 150_000 },
	review: { maxTurns: 20, maxDuration: 600, tokenBudget: 100_000 },
	exploration: { maxTurns: 25, maxDuration: 300, tokenBudget: 100_000 },
	planning: { maxTurns: 10, maxDuration: 180, tokenBudget: 60_000 },
	fermentStep: { maxTurns: 15, maxDuration: 300, tokenBudget: 75_000 },
} as const satisfies Record<string, AgentWorkerBudget>

export const MAX_FERMENT_WORKER_OUTPUT_TOKENS = 225_000

export function renderAgentWorkerBudgetTable(): string {
	const rows: Array<[string, AgentWorkerBudget]> = [
		["Single file (one module, one test file, one doc)", AGENT_WORKER_BUDGETS.singleFile],
		["Multi-file package (concurrent logic, worker pools, complex state)", AGENT_WORKER_BUDGETS.multiFile],
		["Review (read code + write findings report)", AGENT_WORKER_BUDGETS.review],
		["Full project or large codebase exploration", AGENT_WORKER_BUDGETS.exploration],
		["Plan or research document (writing, not coding)", AGENT_WORKER_BUDGETS.planning],
		["Ferment step (default for start_ferment_step workers)", AGENT_WORKER_BUDGETS.fermentStep],
	]
	return [
		"| Agent task scope | max_turns | max_duration | token_budget |",
		"|---|---:|---:|---:|",
		...rows.map(
			([label, budget]) => `| ${label} | ${budget.maxTurns} | ${budget.maxDuration}s | ${budget.tokenBudget} |`,
		),
	].join("\n")
}
