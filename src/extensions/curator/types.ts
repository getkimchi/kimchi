export interface TransitionProposal {
	checked: string[]
	proposeStale: string[]
	proposeArchive: string[]
	proposeReactivate: string[]
}

export interface LogSummary {
	summaries: string[]
	failurePatterns: { type: string; count: number; lastSeen: string }[]
}

export interface SkillMetadata {
	name: string
	description: string
	triggers: string[]
	category: string
	state: "active" | "stale" | "archived" // NOTE: stale added for curator
	useCount: number
	lastUsedAt: string | null
	agentCreated: boolean
}

export interface ConsolidationProposal {
	umbrella: string
	members: string[]
	rationale: string
}

export interface SkillGap {
	topic: string
	evidence: string
	suggestedTriggers: string[]
}

export interface QualityIssue {
	skill: string
	issue: "missing_description" | "missing_triggers" | "unclear"
	suggestion: string
}

export interface CuratorReport {
	autoTransitions: TransitionProposal
	consolidationProposals: ConsolidationProposal[]
	skillGaps: SkillGap[]
	qualityIssues: QualityIssue[]
}

export interface ExecutionResult {
	phaseA: { success: boolean; error?: string }
	phaseB: { succeeded: string[]; failed: { proposal: string; error: string }[] }
}
