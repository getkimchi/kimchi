import type { ApprovalOutcome } from "./prompts.js"
import type { RiskScore, Rule } from "./types.js"

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
	/** Risk score from the classifier LLM, for display in the prompt. */
	riskScore?: RiskScore
	choices: PermissionChoice[]
	signal?: AbortSignal
}

export interface ToolPermissionPrompter {
	request(req: PermissionRequest): Promise<ApprovalOutcome>
}
