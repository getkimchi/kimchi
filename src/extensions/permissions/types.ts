export type PermissionMode = "default" | "plan" | "auto" | "yolo"

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

export const DEFAULT_CONFIG: PermissionsConfig = {
	defaultMode: "default",
	allow: [],
	deny: [],
	classifierTimeoutMs: 8000,
}

// Denylist applied as the lowest-precedence rule source. Users can override by
// adding matching allow rules at a higher-precedence source.
export const BUILTIN_DENY: string[] = [
	"bash(rm -rf /*)",
	"bash(sudo *)",
	"write(.env)",
	"write(.env.*)",
	"edit(.env)",
	"edit(.env.*)",
]
