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

// Consolidation strategies (three options)
export type ConsolidationStrategy = "merge_into_existing" | "create_new" | "demote_to_references"

export interface ConsolidationProposal {
	umbrella: string
	members: string[]
	rationale: string
	strategy: ConsolidationStrategy
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
	audit?: AuditDigest
}

// Audit record types
export interface AuditDigest {
	timestamp: string
	skillCountBefore: number
	skillCountAfter: number
	consolidations: ConsolidationRecord[]
	autoTransitionsApplied: TransitionRecord[]
	rollbacks: RollbackRecord[]
}

export interface ConsolidationRecord {
	umbrella: string
	members: string[] // NOTE: unified to members (not absorbed)
	strategy: ConsolidationStrategy
	rationale: string
	referencesCreated: string[]
}

export interface TransitionRecord {
	name: string
	from: string
	to: string
}

export interface RollbackRecord {
	timestamp: string
	backupDir: string
	reason: string
}

// TDD phase types
export type TDDPhase = "RED" | "GREEN" | "REFACTOR"

export interface SubagentBaselineResult {
	phase: "RED"
	prompt: string
	output: string
	skillsUsed: string[]
	skillsNeeded: string[]
	gapsIdentified: string[]
}

export interface SubagentVerifyResult {
	phase: "REFACTOR"
	prompt: string
	output: string
	umbrellaUsed: boolean
	behaviors: string[]
}

export interface ExecutionResult {
	phaseA: { success: boolean; error?: string }
	phaseB: { succeeded: string[]; failed: { proposal: string; error: string }[] }
}
