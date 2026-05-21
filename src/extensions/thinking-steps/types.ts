export type ThinkingStepsMode = "collapsed" | "summary" | "expanded"
export type PersistedThinkingStepsPreferenceScope = "project" | "global"

export type ThinkingSemanticRole = "inspect" | "plan" | "compare" | "verify" | "write" | "search" | "error" | "default"

export type ThinkingSummaryEventType =
	| "failure"
	| "success"
	| "decision"
	| "plan_change"
	| "uncertainty"
	| "action"
	| "focus"
	| "generic"

export interface ThinkingSummaryEvent {
	type: ThinkingSummaryEventType
	text: string
	order: number
	priority: number
}

export interface ThinkingSourceBlock {
	contentIndex: number
	text: string
	redacted?: boolean
}

export interface DerivedThinkingStep {
	id: string
	contentIndex: number
	blockIndex: number
	stepIndex: number
	summary: string
	body: string
	role: ThinkingSemanticRole
	icon: string
	baselineSummary?: string
	challengerSummary?: string
	summaryEvents?: ThinkingSummaryEvent[]
	collapsedPriority?: number
	hasExplicitFailure?: boolean
	hasExplicitSuccess?: boolean
}

export interface ActiveThinkingState {
	messageTimestamp?: number
	contentIndex?: number
	active: boolean
}

export interface ThinkingThemeLike {
	fg(color: string, text: string): string
	bold(text: string): string
}
