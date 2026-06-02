import type { ApprovalOutcome } from "./prompts.js"
import type { Rule } from "./types.js"

export type PermissionChoice =
	| { kind: "allow-once"; label: string }
	| { kind: "allow-remember"; label: string; rule: Rule }
	| { kind: "allow-remember-wildcard"; label: string; rule: Rule }
	| { kind: "deny"; label: string }

export interface PermissionRequest {
	toolCallId: string
	toolName: string
	input: Record<string, unknown>
	subtitle?: string
	choices: PermissionChoice[]
	signal?: AbortSignal
}

export interface ToolPermissionPrompter {
	request(req: PermissionRequest): Promise<ApprovalOutcome>
}
