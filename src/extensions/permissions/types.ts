export type PermissionMode = "default" | "plan" | "auto" | "yolo"

export interface PermissionModeMeta {
	label: string
	tuiLabel: string
	description: string
	color: "success" | "warning" | "error"
}

/** Source of a runtime permission mode change. */
export type PermissionModeRuntimeSource = "user" | "ferment"

export type RuleBehavior = "allow" | "deny"

export type RuleSource = "session" | "cli" | "local" | "project" | "user" | "builtin"

export interface Rule {
	toolName: string
	content?: string
	behavior: RuleBehavior
	source: RuleSource
}

export type ToolCategory = "readOnly" | "write" | "execute" | "network" | "unknown"

export type ClassifierVerdict = "safe" | "requires-confirmation" | "blocked"

export interface ClassifierResult {
	verdict: ClassifierVerdict
	reason: string
	/** True when the classifier LLM returned a parseable, well-formed verdict. */
	ok: boolean
}

export interface PermissionsConfig {
	defaultMode: PermissionMode
	allow: string[]
	deny: string[]
	classifierTimeoutMs: number
}

/** Controller for session-scoped permission flags with subscription support. */
export interface SessionPermissionFlagController {
	getMode(): {
		mode: PermissionMode
		source: PermissionModeRuntimeSource
	}
	setMode(mode: PermissionMode, source: PermissionModeRuntimeSource, skipNotify?: boolean): void
	subscribe(listener: (changes: SessionPermissionFlagChanges) => void): () => void
}

export interface SessionPermissionFlagChanges {
	mode?: {
		mode: PermissionMode
		source: PermissionModeRuntimeSource
	}
}
