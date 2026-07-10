import type { ThinkingLevel } from "./personas/types.js"

export type ChunkComplexity = "simple" | "complex"

/** Delegation scopes aligned with Orchestration phases and agent types. */
export type ThinkingTaskScope =
	| "explore"
	| "research"
	| "plan"
	| "build"
	| "review"
	| "fix"
	| "orchestrator-coord"
	| "orchestrator-judge"

export const THINKING_LEVEL_ORDER: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const

const DELEGATION_THINKING_BASE: Record<ThinkingTaskScope, Record<ChunkComplexity, ThinkingLevel>> = {
	explore: { simple: "minimal", complex: "low" },
	research: { simple: "low", complex: "medium" },
	plan: { simple: "high", complex: "high" },
	build: { simple: "medium", complex: "high" },
	review: { simple: "medium", complex: "high" },
	fix: { simple: "medium", complex: "high" },
	"orchestrator-coord": { simple: "low", complex: "low" },
	"orchestrator-judge": { simple: "high", complex: "high" },
}

/** Retry ceilings — avoid burning xhigh on lightweight explorers. */
const THINKING_RETRY_CEILING: Partial<Record<ThinkingTaskScope, ThinkingLevel>> = {
	explore: "medium",
	research: "high",
	plan: "high",
	review: "high",
	fix: "high",
	build: "xhigh",
}

const SUBAGENT_TYPE_TO_SCOPE: Record<string, ThinkingTaskScope> = {
	Explore: "explore",
	Plan: "plan",
	Researcher: "research",
	Builder: "build",
	Reviewer: "review",
	Fixer: "fix",
}

export function thinkingScopeForSubagentType(subagentType: string): ThinkingTaskScope | undefined {
	return SUBAGENT_TYPE_TO_SCOPE[subagentType]
}

export function bumpThinkingLevel(level: ThinkingLevel, steps = 1, ceiling: ThinkingLevel = "xhigh"): ThinkingLevel {
	const idx = THINKING_LEVEL_ORDER.indexOf(level)
	const ceilIdx = THINKING_LEVEL_ORDER.indexOf(ceiling)
	if (idx < 0) return level
	const target = Math.min(ceilIdx >= 0 ? ceilIdx : THINKING_LEVEL_ORDER.length - 1, idx + steps)
	return THINKING_LEVEL_ORDER[target] ?? level
}

/**
 * Resolve the thinking level for a delegated worker or orchestrator sub-step.
 * `retryRound` bumps one tier per retry (budget exhausted, stalled approach, etc.).
 */
export function resolveDelegationThinkingLevel(
	scope: ThinkingTaskScope,
	complexity: ChunkComplexity,
	retryRound = 0,
): ThinkingLevel {
	const base = DELEGATION_THINKING_BASE[scope][complexity]
	if (retryRound <= 0) return base
	const ceiling = THINKING_RETRY_CEILING[scope] ?? "xhigh"
	return bumpThinkingLevel(base, retryRound, ceiling)
}

export function renderDelegationThinkingLevelTable(): string {
	const rows: Array<[string, string, ThinkingLevel, ThinkingLevel, ThinkingLevel]> = [
		["Explore (bounded fact-finding)", "Explore", "minimal", "low", "medium"],
		["Research note", "Researcher", "low", "medium", "high"],
		["Plan or plan verification", "Plan", "high", "high", "high"],
		["Build chunk", "Builder", "medium", "high", "xhigh"],
		["Review report", "Reviewer", "medium", "high", "high"],
		["Fix round", "Fixer", "medium", "high", "high"],
	]
	return [
		"| Work shape | Agent type | simple chunk | complex chunk | after 1 retry (+1 tier) |",
		"|---|---|---:|---:|---:|",
		...rows.map(
			([label, agentType, simple, complex, retry]) => `| ${label} | ${agentType} | ${simple} | ${complex} | ${retry} |`,
		),
	].join("\n")
}

export function renderOrchestratorThinkingTable(): string {
	return [
		"| Orchestrator activity | thinking |",
		"|---|---:|",
		"| Orientation, spawning agents, reading artifact paths | low |",
		"| Pipeline selection and intent boundaries | medium |",
		"| Plan self-validation or interpreting NEEDS_REVISION | high |",
		"| Recovery after agent_outcome ≠ completed (retry) | medium → high |",
	].join("\n")
}
