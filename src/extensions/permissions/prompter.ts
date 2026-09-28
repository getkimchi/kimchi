import type { ApprovalOutcome } from "./prompts.js"
import type { RiskScore, Rule } from "./types.js"

export type PermissionChoice =
	| { kind: "allow-once"; label: string }
	| { kind: "allow-remember"; label: string; rules: Rule[] }
	| { kind: "allow-remember-wildcard"; label: string; rules: Rule[] }
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

	// NOTE: remember choices carry multiple rules because compound bash
	// commands produce one rule per segment (the compound gate evaluates
	// segments independently and requires all of them allowed).
}

export interface ToolPermissionPrompter {
	request(req: PermissionRequest): Promise<ApprovalOutcome>
}
