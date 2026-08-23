export type PermissionMode = "default" | "plan" | "auto" | "yolo"

export interface PermissionModeMeta {
	label: string
	tuiLabel: string
	description: string
	color: "success" | "warning" | "error"
}

/** Where the effective permission mode came from in the resolution precedence. */
export type PermissionModeSource = "runtime" | "flag" | "env" | "config"

/** Who or what set the runtime permission mode. */
export type PermissionModeInitiatedBy = "user" | "ferment"

export type RuleBehavior = "allow" | "deny"

export type RuleSource = "session" | "cli" | "local" | "project" | "user" | "builtin"

export interface Rule {
	toolName: string
	content?: string
	behavior: RuleBehavior
	source: RuleSource
}

export type ToolCategory = "readOnly" | "write" | "execute" | "network" | "unknown"

export type ClassifierVerdict = "safe" | "requires-confirmation"

/** Risk score returned by the LLM classifier for display in the permission prompt. */
export type RiskScore = "low" | "medium" | "high"

export interface ClassifierResult {
	verdict: ClassifierVerdict
	reason: string
	/** True when the classifier LLM returned a parseable, well-formed verdict. */
	ok: boolean
	/** Risk score from the classifier LLM. Undefined when the classifier was not called or failed. */
	riskScore?: RiskScore
}

export interface PermissionsConfig {
	defaultMode: PermissionMode
	allow: string[]
	deny: string[]
	classifierTimeoutMs: number
}

/** Controller for session-scoped permission flags with subscription support. */
export interface SessionPermissionFlagController {
	getMode(): PermissionModeState
	setMode(mode: PermissionModeState, skipNotify?: boolean): void
	subscribe(listener: (changes: SessionPermissionFlagChanges) => void): () => void
}

export interface SessionPermissionFlagChanges {
	mode?: PermissionModeState
}

export interface PermissionModeState {
	mode: PermissionMode
	source: PermissionModeSource
	initiatedBy: PermissionModeInitiatedBy
}
