export interface AgentWorkerBudget {
	maxTurns: number
	maxDuration: number
	tokenBudget: number
}

export type FermentWorkerBudgetTier = "narrow" | "standard" | "complex"

export interface FermentWorkerBudget extends AgentWorkerBudget {
	cumulativeTokenBudget: number
}

/** Explicit structural tiers for Ferment workers. Callers choose by scoped work shape, never prompt keywords. */
export const FERMENT_WORKER_BUDGETS = {
	narrow: { maxTurns: 10, maxDuration: 180, tokenBudget: 50_000, cumulativeTokenBudget: 100_000 },
	standard: { maxTurns: 25, maxDuration: 300, tokenBudget: 100_000, cumulativeTokenBudget: 250_000 },
	complex: { maxTurns: 30, maxDuration: 600, tokenBudget: 150_000, cumulativeTokenBudget: 375_000 },
} as const satisfies Record<FermentWorkerBudgetTier, FermentWorkerBudget>

/** Shared delegation budgets used by prompts and Ferment step handoffs. */
export const AGENT_WORKER_BUDGETS = {
	singleFile: { maxTurns: 12, maxDuration: 300, tokenBudget: 50_000 },
	multiFile: { maxTurns: 30, maxDuration: 600, tokenBudget: 150_000 },
	review: { maxTurns: 20, maxDuration: 600, tokenBudget: 100_000 },
	exploration: { maxTurns: 25, maxDuration: 300, tokenBudget: 100_000 },
	planning: { maxTurns: 10, maxDuration: 180, tokenBudget: 60_000 },
	fermentStep: FERMENT_WORKER_BUDGETS.standard,
} as const satisfies Record<string, AgentWorkerBudget>

export function renderAgentWorkerBudgetTable(): string {
	const rows: Array<[string, AgentWorkerBudget]> = [
		["Single file (one module, one test file, one doc)", AGENT_WORKER_BUDGETS.singleFile],
		["Multi-file package (concurrent logic, worker pools, complex state)", AGENT_WORKER_BUDGETS.multiFile],
		["Review (read code + write findings report)", AGENT_WORKER_BUDGETS.review],
		["Full project or large codebase exploration", AGENT_WORKER_BUDGETS.exploration],
		["Plan or research document (writing, not coding)", AGENT_WORKER_BUDGETS.planning],
		["Ferment step — narrow (verification or one small edit)", FERMENT_WORKER_BUDGETS.narrow],
		["Ferment step — standard (normal implementation, default)", FERMENT_WORKER_BUDGETS.standard],
		["Ferment step — complex (multi-file build or iterative debugging)", FERMENT_WORKER_BUDGETS.complex],
	]
	return [
		"| Agent task scope | max_turns | max_duration | token_budget |",
		"|---|---:|---:|---:|",
		...rows.map(
			([label, budget]) => `| ${label} | ${budget.maxTurns} | ${budget.maxDuration}s | ${budget.tokenBudget} |`,
		),
	].join("\n")
}
